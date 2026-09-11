package server

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/dataaccess"
	"github.com/krillinai/Clawee/server/internal/rbac"
)

type dataResourceGrantSearchRequest struct {
	ResourceType string `json:"resource_type"`
	ResourceID   string `json:"resource_id"`
	Action       string `json:"action"`
	Query        string `json:"query"`
	Page         int    `json:"page"`
	PageSize     int    `json:"page_size"`
}

type dataResourceGrantMutationRequest struct {
	UserID       string   `json:"user_id"`
	ResourceType string   `json:"resource_type"`
	ResourceID   string   `json:"resource_id"`
	Actions      []string `json:"actions"`
}

type dataResourceTypeResponse struct {
	ResourceType  string     `json:"resource_type"`
	Name          string     `json:"name"`
	ResourceCount int        `json:"resource_count"`
	ActionCount   int        `json:"action_count"`
	UserCount     int        `json:"user_count"`
	UpdatedAt     *time.Time `json:"updated_at,omitempty"`
}

type dataResourceGrantResourceResponse struct {
	ResourceType     string                                      `json:"resource_type"`
	ResourceID       string                                      `json:"resource_id"`
	Name             string                                      `json:"name"`
	Actions          []string                                    `json:"actions"`
	AvailableActions []dataResourceGrantActionDefinitionResponse `json:"available_actions"`
	UserCount        int                                         `json:"user_count"`
	UpdatedAt        *time.Time                                  `json:"updated_at,omitempty"`
}

type dataResourceGrantActionDefinitionResponse struct {
	Action         string `json:"action"`
	Name           string `json:"name"`
	Description    string `json:"description"`
	Required       bool   `json:"required"`
	DefaultChecked bool   `json:"default_checked"`
}

type dataResourceGrantActionResponse struct {
	Action         string     `json:"action"`
	Name           string     `json:"name"`
	Description    string     `json:"description"`
	Required       bool       `json:"required"`
	DefaultChecked bool       `json:"default_checked"`
	UserCount      int        `json:"user_count"`
	UpdatedAt      *time.Time `json:"updated_at,omitempty"`
}

type dataResourceGrantUserResponse struct {
	GrantID       string    `json:"grant_id"`
	UserID        string    `json:"user_id"`
	Name          string    `json:"name"`
	Email         string    `json:"email"`
	AccountStatus string    `json:"account_status"`
	CreatedBy     string    `json:"created_by"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

type dataResourceGrantMemberResponse struct {
	UserID        string    `json:"user_id"`
	Name          string    `json:"name"`
	Email         string    `json:"email"`
	AccountStatus string    `json:"account_status"`
	Actions       []string  `json:"actions"`
	UpdatedAt     time.Time `json:"updated_at"`
}

type dataResourceGrantCandidateResponse struct {
	UserID string `json:"user_id"`
	Name   string `json:"name"`
	Email  string `json:"email"`
}

func mountDataResourceGrantRoutes(admin *gin.RouterGroup, opts Options) {
	if opts.DataAccessService == nil || opts.AccountService == nil {
		return
	}
	read := requirePermission(opts.RBACService, rbac.PermissionDataResourceGrantRead)
	admin.GET("/data-resource-grants/resource-types", read, handleDataResourceGrantTypes(opts))
	admin.POST("/data-resource-grants/resources/search", read, handleDataResourceGrantResources(opts))
	admin.POST("/data-resource-grants/actions/search", read, handleDataResourceGrantActions(opts))
	admin.POST("/data-resource-grants/users/search", read, handleDataResourceGrantUsers(opts))
	admin.POST("/data-resource-grants/members/search", read, handleDataResourceGrantMembers(opts))
	admin.POST("/data-resource-grants/member-candidates/search", requireAnyPermission(opts.RBACService, rbac.PermissionDataResourceGrantCreate, rbac.PermissionDataResourceGrantUpdate), handleDataResourceGrantMemberCandidates(opts))
	admin.POST("/data-resource-grants", requirePermission(opts.RBACService, rbac.PermissionDataResourceGrantCreate), handleDataResourceGrantMutation(opts, false))
	admin.PATCH("/data-resource-grants", requirePermission(opts.RBACService, rbac.PermissionDataResourceGrantUpdate), handleDataResourceGrantMutation(opts, true))
	admin.POST("/data-resource-grants/remove", requirePermission(opts.RBACService, rbac.PermissionDataResourceGrantDelete), handleDataResourceGrantRemove(opts))
}

func handleDataResourceGrantMutation(opts Options, replace bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		var request dataResourceGrantMutationRequest
		if c.Request.URL.RawQuery != "" || c.ShouldBindJSON(&request) != nil {
			dataResourceGrantMutationError(c, dataaccess.ErrInvalidRequest)
			return
		}
		operator, _ := currentAccount(c)
		input := dataaccess.SetInput{UserID: request.UserID, ResourceType: request.ResourceType, ResourceID: request.ResourceID,
			Actions: request.Actions, CreatedBy: operator.UserID, OperatorID: operator.UserID, RequestID: requestIDFromContext(c.Request.Context())}
		if target, err := opts.AccountService.Account(c.Request.Context(), request.UserID); err != nil || target.Status != accounts.StatusActive {
			if !recordDataResourceGrantFailure(c, opts, input) {
				return
			}
			dataResourceGrantMutationError(c, dataaccess.ErrNotFound)
			return
		}
		var (
			items []dataaccess.Grant
			err   error
		)
		if replace {
			items, err = opts.DataAccessService.Replace(c.Request.Context(), input)
		} else {
			items, err = opts.DataAccessService.Create(c.Request.Context(), input)
		}
		if err != nil {
			if !recordDataResourceGrantFailure(c, opts, input) {
				return
			}
			dataResourceGrantMutationError(c, err)
			return
		}
		status := http.StatusCreated
		if replace {
			status = http.StatusOK
		}
		c.JSON(status, gin.H{"data": items})
	}
}

func handleDataResourceGrantRemove(opts Options) gin.HandlerFunc {
	return func(c *gin.Context) {
		var request dataResourceGrantMutationRequest
		if c.Request.URL.RawQuery != "" || c.ShouldBindJSON(&request) != nil || request.Actions != nil {
			dataResourceGrantMutationError(c, dataaccess.ErrInvalidRequest)
			return
		}
		operator, _ := currentAccount(c)
		err := opts.DataAccessService.RemoveBy(c.Request.Context(), request.UserID, request.ResourceType, request.ResourceID, operator.UserID, requestIDFromContext(c.Request.Context()))
		if err != nil {
			if !recordDataResourceGrantFailure(c, opts, dataaccess.SetInput{UserID: request.UserID, ResourceType: request.ResourceType,
				ResourceID: request.ResourceID, CreatedBy: operator.UserID, OperatorID: operator.UserID, RequestID: requestIDFromContext(c.Request.Context())}) {
				return
			}
			dataResourceGrantMutationError(c, err)
			return
		}
		c.Status(http.StatusNoContent)
	}
}

func recordDataResourceGrantFailure(c *gin.Context, opts Options, input dataaccess.SetInput) bool {
	if err := opts.DataAccessService.RecordFailure(c.Request.Context(), input); err != nil {
		if opts.Logger != nil {
			opts.Logger.Error("record data resource grant failure audit", zap.String("request_id", input.RequestID), zap.Error(err))
		}
		dataResourceGrantMutationError(c, err)
		return false
	}
	return true
}

func dataResourceGrantMutationError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, dataaccess.ErrInvalidRequest):
		activityError(c, http.StatusBadRequest, "invalid_data_resource_grant_request", "数据资源授权参数无效")
	case errors.Is(err, dataaccess.ErrConflict):
		activityError(c, http.StatusConflict, "grant_conflict", "数据资源授权已存在")
	case errors.Is(err, dataaccess.ErrNotFound):
		activityError(c, http.StatusNotFound, "grant_not_found", "数据资源授权或目标账户不存在")
	default:
		activityError(c, http.StatusInternalServerError, "data_resource_grant_failed", "数据资源授权操作失败")
	}
}

func handleDataResourceGrantTypes(opts Options) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !dataResourceGrantURLHasNoParameters(c) {
			return
		}
		grants, err := opts.DataAccessService.List(c.Request.Context(), dataaccess.Filter{})
		if err != nil {
			dataResourceGrantError(c, err)
			return
		}
		catalog := dataaccess.ResourceCatalog()
		resourceNames := make(map[string]map[string]string, len(catalog))
		for _, definition := range catalog {
			names, err := dataResourceNames(c.Request.Context(), opts, definition.ResourceType)
			if err != nil {
				dataResourceGrantError(c, err)
				return
			}
			resourceNames[definition.ResourceType] = names
		}
		items := summarizeDataResourceTypes(grants, resourceNames)
		c.JSON(http.StatusOK, gin.H{"data": items, "meta": gin.H{"next_cursor": "", "has_next": false}})
	}
}

func handleDataResourceGrantResources(opts Options) gin.HandlerFunc {
	return func(c *gin.Context) {
		var request dataResourceGrantSearchRequest
		if !bindDataResourceGrantSearch(c, &request) {
			return
		}
		if !validDataResourceType(request.ResourceType) {
			dataResourceGrantInvalidRequest(c)
			return
		}
		grants, err := opts.DataAccessService.List(c.Request.Context(), dataaccess.Filter{ResourceType: request.ResourceType})
		if err != nil {
			dataResourceGrantError(c, err)
			return
		}
		names, err := dataResourceNames(c.Request.Context(), opts, request.ResourceType)
		if err != nil {
			dataResourceGrantError(c, err)
			return
		}
		items := summarizeDataResources(request.ResourceType, grants, names, request.Query)
		page, pageSize := normalizeDataResourceGrantPage(request.Page, request.PageSize)
		paged := paginate(items, page, pageSize)
		c.JSON(http.StatusOK, gin.H{"data": paged, "meta": pageMeta(page, pageSize, len(items))})
	}
}

func handleDataResourceGrantActions(opts Options) gin.HandlerFunc {
	return func(c *gin.Context) {
		var request dataResourceGrantSearchRequest
		if !bindDataResourceGrantSearch(c, &request) || !validDataResourceType(request.ResourceType) || request.ResourceID == "" {
			if !c.IsAborted() {
				dataResourceGrantInvalidRequest(c)
			}
			return
		}
		grants, err := opts.DataAccessService.List(c.Request.Context(), dataaccess.Filter{
			ResourceType: request.ResourceType,
			ResourceID:   request.ResourceID,
		})
		if err != nil {
			dataResourceGrantError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": summarizeDataResourceActions(request.ResourceType, request.ResourceID, grants), "meta": gin.H{"next_cursor": "", "has_next": false}})
	}
}

func handleDataResourceGrantUsers(opts Options) gin.HandlerFunc {
	return func(c *gin.Context) {
		var request dataResourceGrantSearchRequest
		if !bindDataResourceGrantSearch(c, &request) || !validDataResourceType(request.ResourceType) || request.ResourceID == "" || request.Action == "" {
			if !c.IsAborted() {
				dataResourceGrantInvalidRequest(c)
			}
			return
		}
		grants, err := opts.DataAccessService.List(c.Request.Context(), dataaccess.Filter{
			ResourceType: request.ResourceType,
			ResourceID:   request.ResourceID,
			Action:       request.Action,
		})
		if err != nil {
			dataResourceGrantError(c, err)
			return
		}
		accountItems, err := opts.AccountService.ListAccounts(c.Request.Context())
		if err != nil {
			dataResourceGrantError(c, err)
			return
		}
		items := dataResourceGrantUsers(grants, accountItems, request.Query)
		page, pageSize := normalizeDataResourceGrantPage(request.Page, request.PageSize)
		c.JSON(http.StatusOK, gin.H{"data": paginate(items, page, pageSize), "meta": pageMeta(page, pageSize, len(items))})
	}
}

func handleDataResourceGrantMembers(opts Options) gin.HandlerFunc {
	return func(c *gin.Context) {
		var request dataResourceGrantSearchRequest
		if !bindDataResourceGrantSearch(c, &request) || !validDataResourceType(request.ResourceType) || request.ResourceID == "" || request.Action != "" {
			if !c.IsAborted() {
				dataResourceGrantInvalidRequest(c)
			}
			return
		}
		grants, err := opts.DataAccessService.List(c.Request.Context(), dataaccess.Filter{
			ResourceType: request.ResourceType,
			ResourceID:   request.ResourceID,
		})
		if err != nil {
			dataResourceGrantError(c, err)
			return
		}
		accountItems, err := opts.AccountService.ListAccounts(c.Request.Context())
		if err != nil {
			dataResourceGrantError(c, err)
			return
		}
		items := dataResourceGrantMembers(grants, accountItems, request.Query)
		page, pageSize := normalizeDataResourceGrantPage(request.Page, request.PageSize)
		c.JSON(http.StatusOK, gin.H{"data": paginate(items, page, pageSize), "meta": pageMeta(page, pageSize, len(items))})
	}
}

func handleDataResourceGrantMemberCandidates(opts Options) gin.HandlerFunc {
	return func(c *gin.Context) {
		var request dataResourceGrantSearchRequest
		if !bindDataResourceGrantSearch(c, &request) || !validDataResourceType(request.ResourceType) || request.ResourceID == "" || request.Action != "" {
			if !c.IsAborted() {
				dataResourceGrantInvalidRequest(c)
			}
			return
		}
		grants, err := opts.DataAccessService.List(c.Request.Context(), dataaccess.Filter{
			ResourceType: request.ResourceType,
			ResourceID:   request.ResourceID,
		})
		if err != nil {
			dataResourceGrantError(c, err)
			return
		}
		accountItems, err := opts.AccountService.ListAccounts(c.Request.Context())
		if err != nil {
			dataResourceGrantError(c, err)
			return
		}
		items := dataResourceGrantMemberCandidates(grants, accountItems, request.Query)
		page, pageSize := normalizeDataResourceGrantPage(request.Page, request.PageSize)
		c.JSON(http.StatusOK, gin.H{"data": paginate(items, page, pageSize), "meta": pageMeta(page, pageSize, len(items))})
	}
}

func bindDataResourceGrantSearch(c *gin.Context, request *dataResourceGrantSearchRequest) bool {
	if !dataResourceGrantURLHasNoParameters(c) {
		return false
	}
	if err := c.ShouldBindJSON(request); err != nil {
		dataResourceGrantInvalidRequest(c)
		return false
	}
	request.ResourceType = strings.TrimSpace(request.ResourceType)
	request.ResourceID = strings.TrimSpace(request.ResourceID)
	request.Action = strings.TrimSpace(request.Action)
	request.Query = strings.TrimSpace(request.Query)
	return true
}

func dataResourceGrantURLHasNoParameters(c *gin.Context) bool {
	if c.Request.URL.RawQuery == "" {
		return true
	}
	dataResourceGrantInvalidRequest(c)
	return false
}

func dataResourceGrantInvalidRequest(c *gin.Context) {
	c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": gin.H{
		"code": "invalid_data_resource_grant_request", "message": "数据资源授权查询参数无效", "details": []any{},
	}})
}

func dataResourceGrantError(c *gin.Context, _ error) {
	c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
		"code": "data_resource_grant_query_failed", "message": "数据资源授权查询失败", "details": []any{},
	}})
}

func validDataResourceType(resourceType string) bool {
	_, ok := dataaccess.ResourceDefinitionFor(resourceType)
	return ok
}

func summarizeDataResourceTypes(grants []dataaccess.Grant, resourceNames map[string]map[string]string) []dataResourceTypeResponse {
	type summary struct {
		resources map[string]struct{}
		actions   map[string]struct{}
		users     map[string]struct{}
		updatedAt time.Time
	}
	catalog := dataaccess.ResourceCatalog()
	summaries := map[string]*summary{}
	for _, definition := range catalog {
		summaries[definition.ResourceType] = &summary{resources: map[string]struct{}{}, actions: map[string]struct{}{}, users: map[string]struct{}{}}
		for resourceID := range resourceNames[definition.ResourceType] {
			summaries[definition.ResourceType].resources[resourceID] = struct{}{}
		}
	}
	for _, grant := range grants {
		item := summaries[grant.ResourceType]
		if item == nil {
			continue
		}
		item.resources[grant.ResourceID] = struct{}{}
		item.actions[grant.Action] = struct{}{}
		item.users[grant.UserID] = struct{}{}
		if grant.UpdatedAt.After(item.updatedAt) {
			item.updatedAt = grant.UpdatedAt
		}
	}
	out := make([]dataResourceTypeResponse, 0, len(catalog))
	for _, definition := range catalog {
		item := summaries[definition.ResourceType]
		response := dataResourceTypeResponse{
			ResourceType: definition.ResourceType, Name: definition.Name,
			ResourceCount: len(item.resources), ActionCount: len(definition.Actions), UserCount: len(item.users),
		}
		if !item.updatedAt.IsZero() {
			response.UpdatedAt = &item.updatedAt
		}
		out = append(out, response)
	}
	return out
}

func summarizeDataResources(resourceType string, grants []dataaccess.Grant, names map[string]string, query string) []dataResourceGrantResourceResponse {
	type summary struct {
		actions   map[string]struct{}
		users     map[string]struct{}
		updatedAt time.Time
	}
	summaries := map[string]*summary{}
	for resourceID := range names {
		summaries[resourceID] = &summary{actions: map[string]struct{}{}, users: map[string]struct{}{}}
	}
	for _, grant := range grants {
		item := summaries[grant.ResourceID]
		if item == nil {
			item = &summary{actions: map[string]struct{}{}, users: map[string]struct{}{}}
			summaries[grant.ResourceID] = item
		}
		item.actions[grant.Action] = struct{}{}
		item.users[grant.UserID] = struct{}{}
		if grant.UpdatedAt.After(item.updatedAt) {
			item.updatedAt = grant.UpdatedAt
		}
	}
	normalizedQuery := strings.ToLower(strings.TrimSpace(query))
	out := make([]dataResourceGrantResourceResponse, 0, len(summaries))
	for resourceID, item := range summaries {
		name := strings.TrimSpace(names[resourceID])
		if name == "" {
			name = resourceID
		}
		if normalizedQuery != "" && !strings.Contains(strings.ToLower(name+" "+resourceID), normalizedQuery) {
			continue
		}
		actions := make([]string, 0, len(item.actions))
		for action := range item.actions {
			actions = append(actions, action)
		}
		sort.Strings(actions)
		response := dataResourceGrantResourceResponse{
			ResourceType: resourceType, ResourceID: resourceID, Name: name,
			Actions: actions, AvailableActions: dataResourceActionDefinitions(resourceType, resourceID), UserCount: len(item.users),
		}
		if !item.updatedAt.IsZero() {
			updatedAt := item.updatedAt
			response.UpdatedAt = &updatedAt
		}
		out = append(out, response)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].ResourceID < out[j].ResourceID
	})
	return out
}

func summarizeDataResourceActions(resourceType, resourceID string, grants []dataaccess.Grant) []dataResourceGrantActionResponse {
	type summary struct {
		users     map[string]struct{}
		updatedAt time.Time
	}
	summaries := map[string]*summary{}
	actionDefinitions := dataaccess.ActionDefinitionsFor(resourceType, resourceID)
	for _, action := range actionDefinitions {
		summaries[action.Action] = &summary{users: map[string]struct{}{}}
	}
	for _, grant := range grants {
		item := summaries[grant.Action]
		if item == nil {
			item = &summary{users: map[string]struct{}{}}
			summaries[grant.Action] = item
		}
		item.users[grant.UserID] = struct{}{}
		if grant.UpdatedAt.After(item.updatedAt) {
			item.updatedAt = grant.UpdatedAt
		}
	}
	out := make([]dataResourceGrantActionResponse, 0, len(actionDefinitions))
	for _, action := range actionDefinitions {
		item := summaries[action.Action]
		response := dataResourceGrantActionResponse{
			Action: action.Action, Name: action.Name, Description: action.Description,
			Required: action.Required, DefaultChecked: action.DefaultChecked, UserCount: len(item.users),
		}
		if !item.updatedAt.IsZero() {
			updatedAt := item.updatedAt
			response.UpdatedAt = &updatedAt
		}
		out = append(out, response)
	}
	return out
}

func dataResourceActionDefinitions(resourceType, resourceID string) []dataResourceGrantActionDefinitionResponse {
	actionDefinitions := dataaccess.ActionDefinitionsFor(resourceType, resourceID)
	if len(actionDefinitions) == 0 {
		return []dataResourceGrantActionDefinitionResponse{}
	}
	items := make([]dataResourceGrantActionDefinitionResponse, 0, len(actionDefinitions))
	for _, action := range actionDefinitions {
		items = append(items, dataResourceGrantActionDefinitionResponse{
			Action: action.Action, Name: action.Name, Description: action.Description,
			Required: action.Required, DefaultChecked: action.DefaultChecked,
		})
	}
	return items
}

func dataResourceGrantUsers(grants []dataaccess.Grant, accountItems []accounts.Account, query string) []dataResourceGrantUserResponse {
	accountByID := make(map[string]accounts.Account, len(accountItems))
	for _, account := range accountItems {
		accountByID[account.UserID] = account
	}
	normalizedQuery := strings.ToLower(strings.TrimSpace(query))
	out := make([]dataResourceGrantUserResponse, 0, len(grants))
	for _, grant := range grants {
		account := accountByID[grant.UserID]
		name := account.DisplayName()
		if name == "" {
			name = grant.UserID
		}
		searchValue := strings.ToLower(name + " " + account.Email + " " + grant.UserID)
		if normalizedQuery != "" && !strings.Contains(searchValue, normalizedQuery) {
			continue
		}
		out = append(out, dataResourceGrantUserResponse{
			GrantID: grant.GrantID, UserID: grant.UserID, Name: name, Email: account.Email,
			AccountStatus: account.Status, CreatedBy: grant.CreatedBy,
			CreatedAt: grant.CreatedAt, UpdatedAt: grant.UpdatedAt,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].UserID < out[j].UserID
	})
	return out
}

func dataResourceGrantMembers(grants []dataaccess.Grant, accountItems []accounts.Account, query string) []dataResourceGrantMemberResponse {
	type memberSummary struct {
		actions   map[string]struct{}
		updatedAt time.Time
	}
	byUserID := map[string]*memberSummary{}
	for _, grant := range grants {
		item := byUserID[grant.UserID]
		if item == nil {
			item = &memberSummary{actions: map[string]struct{}{}}
			byUserID[grant.UserID] = item
		}
		item.actions[grant.Action] = struct{}{}
		if grant.UpdatedAt.After(item.updatedAt) {
			item.updatedAt = grant.UpdatedAt
		}
	}
	accountByID := make(map[string]accounts.Account, len(accountItems))
	for _, account := range accountItems {
		accountByID[account.UserID] = account
	}
	normalizedQuery := strings.ToLower(strings.TrimSpace(query))
	items := make([]dataResourceGrantMemberResponse, 0, len(byUserID))
	for userID, summary := range byUserID {
		account := accountByID[userID]
		name := account.DisplayName()
		if name == "" {
			name = userID
		}
		if normalizedQuery != "" && !strings.Contains(strings.ToLower(userID+" "+name+" "+account.Email), normalizedQuery) {
			continue
		}
		actions := make([]string, 0, len(summary.actions))
		for action := range summary.actions {
			actions = append(actions, action)
		}
		sort.Strings(actions)
		items = append(items, dataResourceGrantMemberResponse{
			UserID: userID, Name: name, Email: account.Email, AccountStatus: account.Status,
			Actions: actions, UpdatedAt: summary.updatedAt,
		})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Name != items[j].Name {
			return items[i].Name < items[j].Name
		}
		return items[i].UserID < items[j].UserID
	})
	return items
}

func dataResourceGrantMemberCandidates(grants []dataaccess.Grant, accountItems []accounts.Account, query string) []dataResourceGrantCandidateResponse {
	memberIDs := map[string]struct{}{}
	for _, grant := range grants {
		memberIDs[grant.UserID] = struct{}{}
	}
	normalizedQuery := strings.ToLower(strings.TrimSpace(query))
	items := make([]dataResourceGrantCandidateResponse, 0, len(accountItems))
	for _, account := range accountItems {
		if account.Status != accounts.StatusActive {
			continue
		}
		if _, exists := memberIDs[account.UserID]; exists {
			continue
		}
		name := account.DisplayName()
		if normalizedQuery != "" && !strings.Contains(strings.ToLower(account.UserID+" "+name+" "+account.Email), normalizedQuery) {
			continue
		}
		items = append(items, dataResourceGrantCandidateResponse{UserID: account.UserID, Name: name, Email: account.Email})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Name != items[j].Name {
			return items[i].Name < items[j].Name
		}
		return items[i].UserID < items[j].UserID
	})
	return items
}

func dataResourceNames(ctx context.Context, opts Options, resourceType string) (map[string]string, error) {
	names := map[string]string{}
	switch resourceType {
	case dataaccess.ResourceSharedSpace:
		if opts.SharedFilesService == nil {
			return names, nil
		}
		cursor := ""
		seenCursors := map[string]struct{}{}
		for {
			page, err := opts.SharedFilesService.ListAdminSpaces(ctx, "", 100, cursor)
			if err != nil {
				return nil, err
			}
			for _, item := range page.Items {
				names[item.SpaceID] = item.Name
			}
			if !page.HasNext || page.NextCursor == "" {
				return names, nil
			}
			if _, exists := seenCursors[page.NextCursor]; exists {
				return names, nil
			}
			seenCursors[page.NextCursor] = struct{}{}
			cursor = page.NextCursor
		}
	case dataaccess.ResourceKnowledgeBase:
		if opts.KnowledgeService == nil {
			return names, nil
		}
		items, err := opts.KnowledgeService.ListKnowledgeBases(ctx)
		if err != nil {
			return nil, err
		}
		for _, item := range items {
			names[item.KnowledgeBaseID] = item.Name
		}
	case dataaccess.ResourceSkillSpace:
		if opts.SkillHubService == nil {
			return names, nil
		}
		items, err := opts.SkillHubService.ListSpaces(ctx)
		if err != nil {
			return nil, err
		}
		for _, item := range items {
			names[item.SpaceID] = item.Name
		}
	case dataaccess.ResourceDataView:
		names[dataaccess.ViewAgentActivity] = "Agent 动态"
		names[dataaccess.ViewXiaohongshuOperation] = "小红书运营"
		names[dataaccess.ViewDouyinAds] = "抖音投放"
		names[dataaccess.ViewBilibiliOperation] = "哔哩哔哩运营"
	}
	return names, nil
}

func normalizeDataResourceGrantPage(page, pageSize int) (int, int) {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 20
	}
	if pageSize > 100 {
		pageSize = 100
	}
	return page, pageSize
}

func paginate[T any](items []T, page, pageSize int) []T {
	start := (page - 1) * pageSize
	if start >= len(items) {
		return []T{}
	}
	end := start + pageSize
	if end > len(items) {
		end = len(items)
	}
	return items[start:end]
}

func pageMeta(page, pageSize, total int) gin.H {
	return gin.H{"page": page, "page_size": pageSize, "total": total}
}
