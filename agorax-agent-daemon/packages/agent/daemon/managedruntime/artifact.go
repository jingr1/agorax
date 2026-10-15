package managedruntime

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func downloadArtifact(ctx context.Context, client *http.Client, artifactURL string, destinationPath string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, artifactURL, nil)
	if err != nil {
		return fmt.Errorf("create managed app runtime artifact request: %w", err)
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("download managed app runtime artifact: %w", err)
	}
	defer func() {
		_ = response.Body.Close()
	}()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("download managed app runtime artifact: unexpected status %d", response.StatusCode)
	}
	if err := os.MkdirAll(filepath.Dir(destinationPath), 0o755); err != nil {
		return fmt.Errorf("create managed app runtime artifact destination parent: %w", err)
	}
	target, err := os.OpenFile(destinationPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return fmt.Errorf("create managed app runtime artifact destination: %w", err)
	}
	defer func() {
		_ = target.Close()
	}()

	report := downloadProgressFromContext(ctx)
	if report != nil {
		report(DownloadProgress{TotalBytes: response.ContentLength})
	}
	reader := io.LimitReader(response.Body, maxManagedAppRuntimeArtifactBytes+1)
	buffer := make([]byte, 64*1024)
	var copied int64
	for {
		n, readErr := reader.Read(buffer)
		if n > 0 {
			copied += int64(n)
			if copied > maxManagedAppRuntimeArtifactBytes {
				return fmt.Errorf("managed app runtime artifact exceeds maximum size %d", maxManagedAppRuntimeArtifactBytes)
			}
			if _, err := target.Write(buffer[:n]); err != nil {
				return fmt.Errorf("write managed app runtime artifact: %w", err)
			}
			if report != nil {
				report(DownloadProgress{DownloadedBytes: copied, TotalBytes: response.ContentLength})
			}
		}
		if errors.Is(readErr, io.EOF) {
			return nil
		}
		if readErr != nil {
			return fmt.Errorf("read managed app runtime artifact: %w", readErr)
		}
	}
}

func extractZipWithLimits(archivePath string, destinationDir string, maxArchiveBytes int64, maxExpandedBytes int64) error {
	info, err := os.Stat(archivePath)
	if err != nil {
		return fmt.Errorf("stat managed app runtime archive: %w", err)
	}
	if info.Size() > maxArchiveBytes {
		return fmt.Errorf("managed app runtime archive exceeds maximum size %d", maxArchiveBytes)
	}
	reader, err := zip.OpenReader(archivePath)
	if err != nil {
		return fmt.Errorf("open managed app runtime archive: %w", err)
	}
	defer func() {
		_ = reader.Close()
	}()

	cleanDestination, err := filepath.Abs(destinationDir)
	if err != nil {
		return fmt.Errorf("resolve managed app runtime destination: %w", err)
	}
	var expandedBytes int64
	for _, entry := range reader.File {
		if entry == nil {
			continue
		}
		cleanName := filepath.Clean(entry.Name)
		if cleanName == "." || strings.HasPrefix(cleanName, ".."+string(os.PathSeparator)) || filepath.IsAbs(cleanName) {
			return fmt.Errorf("managed app runtime archive contains unsafe path %q", entry.Name)
		}
		targetPath := filepath.Join(cleanDestination, cleanName)
		cleanTarget, err := filepath.Abs(targetPath)
		if err != nil {
			return fmt.Errorf("resolve managed app runtime archive entry: %w", err)
		}
		if cleanTarget != cleanDestination && !strings.HasPrefix(cleanTarget, cleanDestination+string(os.PathSeparator)) {
			return fmt.Errorf("managed app runtime archive entry escapes destination: %q", entry.Name)
		}
		info := entry.FileInfo()
		if info.IsDir() {
			if err := os.MkdirAll(cleanTarget, 0o755); err != nil {
				return fmt.Errorf("create managed app runtime directory: %w", err)
			}
			continue
		}
		expandedBytes += int64(entry.UncompressedSize64)
		if expandedBytes > maxExpandedBytes {
			return fmt.Errorf("managed app runtime archive exceeds maximum expanded size %d", maxExpandedBytes)
		}
		if err := os.MkdirAll(filepath.Dir(cleanTarget), 0o755); err != nil {
			return fmt.Errorf("create managed app runtime file parent: %w", err)
		}
		source, err := entry.Open()
		if err != nil {
			return fmt.Errorf("open managed app runtime archive entry: %w", err)
		}
		mode := info.Mode().Perm()
		if mode == 0 {
			mode = 0o644
		}
		target, err := os.OpenFile(cleanTarget, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
		if err != nil {
			_ = source.Close()
			return fmt.Errorf("create managed app runtime file: %w", err)
		}
		_, copyErr := io.Copy(target, io.LimitReader(source, maxExpandedBytes+1))
		closeErr := errors.Join(target.Close(), source.Close())
		if err := errors.Join(copyErr, closeErr); err != nil {
			return fmt.Errorf("extract managed app runtime file: %w", err)
		}
	}
	return nil
}

func fileSHA256AndSize(path string) (string, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", 0, fmt.Errorf("open file for sha256: %w", err)
	}
	defer func() {
		_ = file.Close()
	}()
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	if err != nil {
		return "", 0, fmt.Errorf("compute file sha256: %w", err)
	}
	return hex.EncodeToString(hash.Sum(nil)), size, nil
}
