package dingtalk

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
)

type ApprovalField struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type ApprovalDetail struct {
	ProcessInstanceID   string          `json:"processInstanceId"`
	ProcessCode         string          `json:"processCode"`
	OriginatorUserID    string          `json:"originatorUserId"`
	Status              string          `json:"status"`
	Result              string          `json:"result"`
	FormComponentValues []ApprovalField `json:"formComponentValues"`
}

func (c *Client) CreateApproval(ctx context.Context, originator, processCode string, fields []ApprovalField) (string, error) {
	token, err := c.getAppToken(ctx)
	if err != nil {
		return "", err
	}
	form, err := json.Marshal(fields)
	if err != nil {
		return "", err
	}
	var response struct {
		InstanceID        string `json:"instanceId"`
		ProcessInstanceID string `json:"processInstanceId"`
	}
	err = c.doJSON(ctx, "create_approval", http.MethodPost, c.endpoints.CreateProcess, map[string]any{
		"originatorUserId": originator, "processCode": processCode, "formComponentValues": string(form),
	}, map[string]string{"x-acs-dingtalk-access-token": token}, &response)
	if err != nil {
		return "", err
	}
	id := strings.TrimSpace(response.InstanceID)
	if id == "" {
		id = strings.TrimSpace(response.ProcessInstanceID)
	}
	if id == "" {
		return "", &APIError{Step: "create_approval", Code: "invalid_response", HTTPStatus: http.StatusOK}
	}
	return id, nil
}

func (c *Client) GetApproval(ctx context.Context, instanceID string) (ApprovalDetail, error) {
	token, err := c.getAppToken(ctx)
	if err != nil {
		return ApprovalDetail{}, err
	}
	endpoint, err := url.Parse(c.endpoints.GetProcess)
	if err != nil {
		return ApprovalDetail{}, err
	}
	query := endpoint.Query()
	query.Set("processInstanceId", instanceID)
	endpoint.RawQuery = query.Encode()
	var response json.RawMessage
	if err = c.doJSON(ctx, "get_approval", http.MethodGet, endpoint.String(), nil, map[string]string{"x-acs-dingtalk-access-token": token}, &response); err != nil {
		return ApprovalDetail{}, err
	}
	var wrapped struct {
		Result json.RawMessage `json:"result"`
	}
	if err = json.Unmarshal(response, &wrapped); err != nil {
		return ApprovalDetail{}, err
	}
	var detail ApprovalDetail
	if len(wrapped.Result) > 0 && wrapped.Result[0] == '{' {
		err = json.Unmarshal(wrapped.Result, &detail)
	} else {
		err = json.Unmarshal(response, &detail)
	}
	if err != nil {
		return ApprovalDetail{}, err
	}
	if detail.ProcessInstanceID == "" {
		detail.ProcessInstanceID = instanceID
	}
	return detail, nil
}
