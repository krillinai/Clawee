package dingtalk

import (
	"errors"
	"fmt"
)

type Member struct {
	UnionID string
	UserID  string
	Name    string
	Email   string
}

type APIError struct {
	Step       string
	Code       string
	HTTPStatus int
}

func (e *APIError) Error() string {
	return fmt.Sprintf("dingtalk %s failed: code=%s status=%d", e.Step, e.Code, e.HTTPStatus)
}

func IsNotEnterpriseMember(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && (apiErr.Code == "60011" || apiErr.Code == "60121" || apiErr.Code == "not_found")
}
