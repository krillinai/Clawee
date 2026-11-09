package dingtalk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

type Member struct {
	Organization     json.RawMessage
	UnionID          string
	UserID           string
	Name             string
	Email            string
	Phone            string
	EnterpriseUserID string
	AvatarURL        string
}

type EmployeeProfile struct {
	Organization     json.RawMessage
	Name             string
	Phone            string
	EnterpriseUserID string
}

type EmployeeDirectory interface {
	LookupEmployee(context.Context, string) (EmployeeProfile, error)
}

var ErrEmployeeNotFound = errors.New("enterprise employee not found")
var ErrEmployeePhoneMissing = errors.New("enterprise employee phone is missing or invalid")

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
	return errors.Is(err, ErrEmployeeNotFound) || errors.As(err, &apiErr) && (apiErr.Code == "60011" || apiErr.Code == "60121" || apiErr.Code == "not_found")
}
