package agentruntime

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	replay "agorax.local/agent-daemon/packages/agent/session-replay"
)

const (
	ProcessCassetteSchemaVersion     = replay.ProcessCassetteSchemaVersion
	ProcessCassetteProjectionVersion = replay.ProcessCassetteProjectionVersion
)

var (
	processCassetteManifestName = "manifest.json"
	processCassetteChunksName   = "frames.jsonl"
	// Provider traffic is expected to be protocol messages, not a bulk file
	// archive. These limits fail the recording before one Session can silently
	// consume unbounded disk space.
	processCassetteMaxPayloadBytes = uint64(replay.MaxProviderPayloadBytes)
	processCassetteMaxStoredBytes  = uint64(replay.MaxProviderTapeBytes)
)

var ErrProcessCassetteSizeLimit = replay.ErrProcessCassetteSizeLimit

type ProcessCassetteStatus = replay.ProcessCassetteStatus

const (
	ProcessCassetteStatusIncomplete = replay.ProcessCassetteStatusIncomplete
	ProcessCassetteStatusComplete   = replay.ProcessCassetteStatusComplete
)

type ProcessCassetteManifest = replay.ProcessCassetteManifest
type ProcessCassetteLimits = replay.ProcessCassetteLimits
type ProcessCassetteKindStats = replay.ProcessCassetteKindStats
type ProcessCassetteCaptureOrigin = replay.ProcessCassetteCaptureOrigin

const (
	ProcessCassetteCaptureOriginProcessStart           = replay.ProcessCassetteCaptureOriginProcessStart
	ProcessCassetteCaptureOriginAttachedLiveConnection = replay.ProcessCassetteCaptureOriginAttachedLiveConnection
)

type ProcessCassetteConnectionRecord = replay.ProcessCassetteConnectionRecord
type processCassetteChunk = replay.ProcessCassetteChunk

type processCassetteWriter struct {
	mu              sync.Mutex
	directory       string
	chunks          *os.File
	manifest        ProcessCassetteManifest
	nextConnection  uint64
	nextGlobalSeq   uint64
	sessionLaunches map[string]uint64
	connectionCWD   map[string]processCassetteCWD
	projections     map[string]*processCassetteProjection
	pending         []*pendingProcessCassetteChunk
	maxPayloadBytes uint64
	maxStoredBytes  uint64
	active          int
	finalized       bool
}

type processCassetteCWD struct {
	recorded string
	token    string
}

type pendingProcessCassetteChunk struct {
	chunk processCassetteChunk
	ready bool
}

func newProcessCassetteWriter(directory string) (*processCassetteWriter, error) {
	directory = strings.TrimSpace(directory)
	if directory == "" {
		return nil, errors.New("process cassette directory is required")
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, fmt.Errorf("create process cassette directory: %w", err)
	}
	chunks, err := os.OpenFile(
		filepath.Join(directory, processCassetteChunksName),
		os.O_CREATE|os.O_TRUNC|os.O_WRONLY,
		0o600,
	)
	if err != nil {
		return nil, fmt.Errorf("create process cassette chunks: %w", err)
	}
	writer := &processCassetteWriter{
		directory: directory,
		chunks:    chunks,
		manifest: ProcessCassetteManifest{
			SchemaVersion:     ProcessCassetteSchemaVersion,
			ProjectionVersion: ProcessCassetteProjectionVersion,
			Status:            ProcessCassetteStatusIncomplete,
			Limits: ProcessCassetteLimits{
				MaxFrameBytes:  processCassetteMaxPayloadBytes,
				MaxStoredBytes: processCassetteMaxStoredBytes,
			},
			FramesByKind: map[string]ProcessCassetteKindStats{},
		},
		sessionLaunches: map[string]uint64{},
		connectionCWD:   map[string]processCassetteCWD{},
		projections:     map[string]*processCassetteProjection{},
		maxPayloadBytes: processCassetteMaxPayloadBytes,
		maxStoredBytes:  processCassetteMaxStoredBytes,
	}
	if err := writer.writeManifestLocked(); err != nil {
		_ = chunks.Close()
		return nil, err
	}
	return writer, nil
}

func (w *processCassetteWriter) start(
	spec ProcessSpec,
	captureOrigin ProcessCassetteCaptureOrigin,
) (string, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.finalized {
		return "", errors.New("process cassette is already finalized")
	}
	sessionKey := normalizeProcessCassetteIdentity(spec.AgentSessionID)
	nextLaunch := w.sessionLaunches[sessionKey] + 1
	cwd := processCassetteCWD{
		recorded: processCassetteProtocolCWD(spec),
		token:    fmt.Sprintf("${SESSION_CWD:%s:%d}", sessionKey, nextLaunch),
	}
	projection, err := newProcessCassetteProjection(spec, cwd)
	if err != nil {
		return "", err
	}
	w.nextConnection++
	connectionID := fmt.Sprintf("connection-%d", w.nextConnection)
	w.sessionLaunches[sessionKey] = nextLaunch
	w.manifest.Connections = append(w.manifest.Connections, ProcessCassetteConnectionRecord{
		ConnectionID:       connectionID,
		Provider:           spec.Provider,
		AgentSessionID:     spec.AgentSessionID,
		RootAgentSessionID: rootProcessSessionID(spec),
		LaunchOrdinal:      nextLaunch,
		CWDToken:           cwd.token,
		CaptureOrigin:      captureOrigin,
	})
	w.connectionCWD[connectionID] = cwd
	w.active++
	if err := w.writeManifestLocked(); err != nil {
		w.active--
		w.manifest.Connections = w.manifest.Connections[:len(w.manifest.Connections)-1]
		delete(w.connectionCWD, connectionID)
		delete(w.projections, connectionID)
		return "", err
	}
	w.projections[connectionID] = projection
	return connectionID, nil
}

func processCassetteProtocolCWD(spec ProcessSpec) string {
	if cwd := strings.TrimSpace(spec.ProtocolCWD); cwd != "" {
		return cwd
	}
	return strings.TrimSpace(spec.CWD)
}

func (w *processCassetteWriter) append(chunk processCassetteChunk) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.finalized {
		return errors.New("process cassette is already finalized")
	}
	payloadBytes, err := processCassetteChunkPayloadBytes(chunk)
	if err != nil {
		return err
	}
	if payloadBytes > w.maxPayloadBytes {
		return fmt.Errorf(
			"%w: %s frame payload is %d bytes, limit is %d bytes",
			ErrProcessCassetteSizeLimit,
			chunk.Kind,
			payloadBytes,
			w.maxPayloadBytes,
		)
	}
	w.nextGlobalSeq++
	chunk.GlobalSeq = w.nextGlobalSeq
	pending := &pendingProcessCassetteChunk{chunk: chunk}
	w.pending = append(w.pending, pending)
	if projection := w.projections[chunk.ConnectionID]; projection != nil {
		if err := projection.project(pending); err != nil {
			w.pending = w.pending[:len(w.pending)-1]
			w.nextGlobalSeq--
			return err
		}
	} else {
		pending.ready = true
	}
	return w.flushPendingLocked()
}

func (w *processCassetteWriter) flushPendingLocked() error {
	for len(w.pending) > 0 && w.pending[0].ready {
		pending := w.pending[0]
		if err := w.writeChunkLocked(pending.chunk); err != nil {
			return err
		}
		w.pending = w.pending[1:]
	}
	return nil
}

func (w *processCassetteWriter) writeChunkLocked(chunk processCassetteChunk) error {
	raw, err := json.Marshal(chunk)
	if err != nil {
		return fmt.Errorf("encode process cassette chunk: %w", err)
	}
	raw = append(raw, '\n')
	payloadBytes, err := processCassetteChunkPayloadBytes(chunk)
	if err != nil {
		return err
	}
	if payloadBytes > w.maxPayloadBytes {
		return fmt.Errorf(
			"%w: %s projected frame payload is %d bytes, limit is %d bytes",
			ErrProcessCassetteSizeLimit,
			chunk.Kind,
			payloadBytes,
			w.maxPayloadBytes,
		)
	}
	projectedStoredBytes := w.manifest.StoredBytes + uint64(len(raw))
	if projectedStoredBytes > w.maxStoredBytes {
		return fmt.Errorf(
			"%w: provider frames would use %d bytes, limit is %d bytes",
			ErrProcessCassetteSizeLimit,
			projectedStoredBytes,
			w.maxStoredBytes,
		)
	}
	if _, err := w.chunks.Write(raw); err != nil {
		return fmt.Errorf("write process cassette chunk: %w", err)
	}
	storedBytes := uint64(len(raw))
	w.manifest.PayloadBytes += payloadBytes
	w.manifest.StoredBytes = projectedStoredBytes
	if payloadBytes > w.manifest.MaxFrameBytes {
		w.manifest.MaxFrameBytes = payloadBytes
	}
	stats := w.manifest.FramesByKind[chunk.Kind]
	stats.FrameCount++
	stats.PayloadBytes += payloadBytes
	stats.StoredBytes += storedBytes
	w.manifest.FramesByKind[chunk.Kind] = stats
	return nil
}

func processCassetteChunkPayloadBytes(chunk processCassetteChunk) (uint64, error) {
	payloadBytes := uint64(len(chunk.Message))
	if chunk.Data == "" {
		return payloadBytes, nil
	}
	data, err := base64.StdEncoding.DecodeString(chunk.Data)
	if err != nil {
		return 0, fmt.Errorf("decode process cassette %s payload for size accounting: %w", chunk.Kind, err)
	}
	return payloadBytes + uint64(len(data)), nil
}

func (w *processCassetteWriter) finishConnection() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.active > 0 {
		w.active--
	}
	return nil
}

func (w *processCassetteWriter) finalize() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.finalized {
		return nil
	}
	if w.active != 0 {
		return fmt.Errorf("cannot finalize process cassette with %d active connections", w.active)
	}
	for _, projection := range w.projections {
		if err := projection.finish(); err != nil {
			return err
		}
	}
	if err := w.flushPendingLocked(); err != nil {
		return err
	}
	if len(w.pending) != 0 {
		return errors.New("process cassette projection left pending frames")
	}
	if err := w.chunks.Sync(); err != nil {
		return fmt.Errorf("sync process cassette chunks: %w", err)
	}
	if err := w.chunks.Close(); err != nil {
		return fmt.Errorf("close process cassette chunks: %w", err)
	}
	digest, err := fileSHA256(filepath.Join(w.directory, processCassetteChunksName))
	if err != nil {
		return fmt.Errorf("hash process cassette frames: %w", err)
	}
	w.manifest.FrameCount = w.nextGlobalSeq
	w.manifest.FramesSHA256 = digest
	w.manifest.Status = ProcessCassetteStatusComplete
	if err := w.writeManifestLocked(); err != nil {
		return err
	}
	w.finalized = true
	return nil
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func (w *processCassetteWriter) abort() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.finalized {
		return nil
	}
	var result error
	if err := w.chunks.Sync(); err != nil {
		result = errors.Join(result, fmt.Errorf("sync process cassette chunks: %w", err))
	}
	if err := w.chunks.Close(); err != nil {
		result = errors.Join(result, fmt.Errorf("close process cassette chunks: %w", err))
	}
	w.finalized = true
	return result
}

func (w *processCassetteWriter) writeManifestLocked() error {
	raw, err := json.MarshalIndent(w.manifest, "", "  ")
	if err != nil {
		return fmt.Errorf("encode process cassette manifest: %w", err)
	}
	raw = append(raw, '\n')
	path := filepath.Join(w.directory, processCassetteManifestName)
	tempPath := path + ".tmp"
	if err := os.WriteFile(tempPath, raw, 0o600); err != nil {
		return fmt.Errorf("write process cassette manifest: %w", err)
	}
	if err := os.Rename(tempPath, path); err != nil {
		return fmt.Errorf("replace process cassette manifest: %w", err)
	}
	return nil
}

func processCassetteFrameChunk(
	connectionID string,
	seq uint64,
	elapsed time.Duration,
	frame ProcessFrame,
) (processCassetteChunk, error) {
	chunk := processCassetteChunk{
		ConnectionID: connectionID,
		ChunkSeq:     seq,
		ElapsedMS:    elapsed.Milliseconds(),
		Message:      frame.Message,
	}
	kinds := 0
	if len(frame.Stdout) > 0 {
		kinds++
		chunk.Kind = "stdout"
		chunk.Data = base64.StdEncoding.EncodeToString(frame.Stdout)
	}
	if len(frame.Stderr) > 0 {
		kinds++
		chunk.Kind = "stderr"
		chunk.Data = base64.StdEncoding.EncodeToString(frame.Stderr)
	}
	if frame.ExitCode != nil {
		kinds++
		chunk.Kind = "exit"
		exitCode := *frame.ExitCode
		chunk.ExitCode = &exitCode
	}
	if kinds != 1 {
		return processCassetteChunk{}, fmt.Errorf(
			"process frame must contain exactly one stdout, stderr, or exit payload; got %d",
			kinds,
		)
	}
	return chunk, nil
}

func decodeProcessCassetteFrame(chunk processCassetteChunk) (ProcessFrame, error) {
	frame := ProcessFrame{Message: chunk.Message}
	switch chunk.Kind {
	case "stdout":
		data, err := base64.StdEncoding.DecodeString(chunk.Data)
		if err != nil {
			return ProcessFrame{}, fmt.Errorf("decode stdout chunk %d: %w", chunk.ChunkSeq, err)
		}
		frame.Stdout = data
	case "stderr":
		data, err := base64.StdEncoding.DecodeString(chunk.Data)
		if err != nil {
			return ProcessFrame{}, fmt.Errorf("decode stderr chunk %d: %w", chunk.ChunkSeq, err)
		}
		frame.Stderr = data
	case "exit":
		if chunk.ExitCode == nil {
			return ProcessFrame{}, fmt.Errorf("exit chunk %d has no exit code", chunk.ChunkSeq)
		}
		exitCode := *chunk.ExitCode
		frame.ExitCode = &exitCode
	default:
		return ProcessFrame{}, fmt.Errorf("unsupported process cassette chunk kind %q", chunk.Kind)
	}
	return frame, nil
}
