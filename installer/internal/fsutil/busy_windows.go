// SPDX-License-Identifier: GPL-3.0-or-later

package fsutil

import (
	"errors"

	"golang.org/x/sys/windows"
)

func isSharingViolation(err error) bool {
	return errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_LOCK_VIOLATION) ||
		errors.Is(err, windows.ERROR_ACCESS_DENIED)
}
