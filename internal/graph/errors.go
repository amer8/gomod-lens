package graph

import (
	"errors"
	"fmt"
)

// InvalidRequestError wraps errors caused by invalid user-supplied analysis requests.
type InvalidRequestError struct {
	Err error
}

// Error returns the wrapped invalid request message.
func (e *InvalidRequestError) Error() string {
	return e.Err.Error()
}

// Unwrap returns the underlying invalid request error.
func (e *InvalidRequestError) Unwrap() error {
	return e.Err
}

func invalidRequestError(err error) error {
	if err == nil {
		return nil
	}
	return &InvalidRequestError{Err: err}
}

func invalidRequestf(format string, args ...any) error {
	return invalidRequestError(fmt.Errorf(format, args...))
}

// IsInvalidRequest reports whether err was caused by invalid request input.
func IsInvalidRequest(err error) bool {
	var target *InvalidRequestError
	return errors.As(err, &target)
}
