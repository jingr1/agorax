package httpclient

import (
	"errors"
	"io"
	"net"
	"strings"
	"syscall"
	"time"
)

var DefaultTransientBackoffs = []time.Duration{
	100 * time.Millisecond,
	300 * time.Millisecond,
}

func IsTransientNetworkError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.EOF) ||
		errors.Is(err, io.ErrUnexpectedEOF) ||
		errors.Is(err, syscall.ECONNRESET) ||
		errors.Is(err, syscall.ECONNREFUSED) ||
		errors.Is(err, syscall.ETIMEDOUT) {
		return true
	}
	if strings.Contains(strings.ToLower(err.Error()), "tls handshake timeout") {
		return true
	}
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}
