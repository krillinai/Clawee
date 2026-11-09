package workflow

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/krillinai/Clawee/server/internal/sharedfiles"
)

type Artifact struct {
	FileID      string `json:"file_id"`
	LogicalPath string `json:"logical_path"`
	Revision    int64  `json:"revision"`
	SHA256      string `json:"sha256"`
	FileName    string `json:"file_name,omitempty"`
	ContentType string `json:"content_type,omitempty"`
	SizeBytes   int64  `json:"size_bytes,omitempty"`
}

type SharedContext struct {
	SharedSpaceID      string     `json:"shared_space_id,omitempty"`
	InstancePathPrefix string     `json:"instance_path_prefix,omitempty"`
	NodePathPrefix     string     `json:"node_path_prefix,omitempty"`
	UpstreamArtifacts  []Artifact `json:"upstream_artifacts,omitempty"`
}

func instancePrefix(id string) string { return "instances/" + id + "/" }
func nodePrefix(instance, node string) string {
	return instancePrefix(instance) + "nodes/" + node + "/"
}
func submissionPrefix(instance, node, user, key string) (string, error) {
	if node == "" || path.Base(node) != node || strings.ContainsAny(node, "\\") || node == "." || node == ".." {
		return "", ErrInvalid
	}
	prefix := nodePrefix(instance, node) + digest([]string{user, key}) + "/"
	if _, err := sharedfiles.NormalizeLogicalPath(prefix, true); err != nil {
		return "", ErrInvalid
	}
	return prefix, nil
}

func artifact(file sharedfiles.File) Artifact {
	return Artifact{FileID: file.FileID, LogicalPath: file.LogicalPath, Revision: file.Revision, SHA256: file.SHA256, FileName: file.FileName, ContentType: file.ContentType, SizeBytes: file.SizeBytes}
}

func matchesArtifact(file sharedfiles.File, ref Artifact) bool {
	return file.FileID == ref.FileID && file.LogicalPath == ref.LogicalPath && file.Revision == ref.Revision && file.SHA256 == ref.SHA256
}

func fileAccessError(err error) error {
	if errors.Is(err, sharedfiles.ErrSharedSpaceNotFound) || errors.Is(err, sharedfiles.ErrSharedFileNotFound) {
		return ErrForbidden
	}
	return err
}

func completionDigest(decision, comment string, output json.RawMessage, attachments []Artifact) string {
	base := struct {
		Decision, Comment string
		Output            json.RawMessage
	}{decision, comment, output}
	if len(attachments) == 0 {
		return digest(base)
	}
	return digest(struct {
		Request     any
		Attachments []Artifact
	}{base, sortArtifacts(attachments)})
}

func (s *Service) ensureTemplateSpace(ctx context.Context, tx pgx.Tx, templateID string) (string, error) {
	var space, templateName, creator string
	if err := tx.QueryRow(ctx, `SELECT COALESCE(shared_space_id,''),name,created_by FROM workflow_templates WHERE id=$1 FOR UPDATE`, templateID).Scan(&space, &templateName, &creator); err != nil {
		return "", err
	}
	if space != "" {
		return space, nil
	}
	if s.Files == nil {
		return "", sharedfiles.ErrStorageUnavailable
	}
	space, err := s.Files.CreateGeneratedSpaceTx(ctx, tx, "工作流-"+strings.TrimSpace(templateName), "", creator)
	if err != nil {
		return "", err
	}
	_, err = tx.Exec(ctx, `UPDATE workflow_templates SET shared_space_id=$2 WHERE id=$1`, templateID, space)
	return space, err
}

func (s *Service) spaceForInstance(ctx context.Context, db interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, instance string) (string, error) {
	var space string
	err := db.QueryRow(ctx, `SELECT COALESCE(t.shared_space_id,'') FROM workflow_instances i JOIN workflow_templates t ON t.id=i.template_id WHERE i.id=$1`, instance).Scan(&space)
	return space, err
}

func (s *Service) initializeSharedFiles(ctx context.Context, instance string) (string, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	var template string
	if err = tx.QueryRow(ctx, `SELECT template_id FROM workflow_instances WHERE id=$1`, instance).Scan(&template); err != nil {
		return "", err
	}
	var space string
	if err = tx.QueryRow(ctx, `SELECT COALESCE(shared_space_id,'') FROM workflow_templates WHERE id=$1 FOR UPDATE`, template).Scan(&space); err != nil {
		return "", err
	}
	var initialized bool
	var status, starter string
	if err = tx.QueryRow(ctx, `SELECT shared_files_initialized,status,started_by FROM workflow_instances WHERE id=$1 FOR UPDATE`, instance).Scan(&initialized, &status, &starter); err != nil {
		return "", err
	}
	if status != "running" {
		return "", ErrConflict
	}
	space, err = s.ensureTemplateSpace(ctx, tx, template)
	if err != nil {
		return "", err
	}
	if !initialized && status == "running" {
		rows, err := tx.Query(ctx, `SELECT p.user_id FROM workflow_instance_participants p JOIN accounts a ON a.user_id=p.user_id AND a.status='active' WHERE instance_id=$1 ORDER BY p.user_id`, instance)
		if err != nil {
			return "", err
		}
		users := []string{}
		for rows.Next() {
			var user string
			if err = rows.Scan(&user); err != nil {
				rows.Close()
				return "", err
			}
			users = append(users, user)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return "", err
		}
		if err = s.Files.EnsureMembersTx(ctx, tx, space, users, starter); err != nil {
			return "", err
		}
		if _, err = tx.Exec(ctx, `UPDATE workflow_instances SET shared_files_initialized=true WHERE id=$1`, instance); err != nil {
			return "", err
		}
	}
	return space, tx.Commit(ctx)
}

func (s *Service) readSharedContext(ctx context.Context, instance, user string, fileAdmin ...bool) (SharedContext, error) {
	var space, status string
	var initialized bool
	err := s.DB.QueryRow(ctx, `SELECT COALESCE(t.shared_space_id,''),i.status,i.shared_files_initialized FROM workflow_instances i JOIN workflow_templates t ON t.id=i.template_id WHERE i.id=$1`, instance).Scan(&space, &status, &initialized)
	if err != nil {
		return SharedContext{}, err
	}
	result := SharedContext{SharedSpaceID: space, InstancePathPrefix: instancePrefix(instance)}
	if space == "" || (!initialized && status != "running") {
		return result, nil
	}
	if s.Files == nil {
		return SharedContext{}, sharedfiles.ErrStorageUnavailable
	}
	if !initialized {
		space, err = s.initializeSharedFiles(ctx, instance)
		if err != nil {
			return SharedContext{}, err
		}
		result.SharedSpaceID = space
	}
	admin := len(fileAdmin) > 0 && fileAdmin[0]
	if !admin {
		if err = s.Files.CheckSpaceAccess(ctx, user, space, sharedfiles.ActionRead); err != nil {
			return SharedContext{}, fileAccessError(err)
		}
	}
	rows, err := s.DB.Query(ctx, `SELECT artifacts_json FROM workflow_node_tasks WHERE instance_id=$1 AND status IN ('completed','rejected') ORDER BY node_order`, instance)
	if err != nil {
		return SharedContext{}, err
	}
	for rows.Next() {
		var raw []byte
		var refs []Artifact
		if err = rows.Scan(&raw); err != nil {
			rows.Close()
			return SharedContext{}, err
		}
		if err = json.Unmarshal(raw, &refs); err != nil {
			rows.Close()
			return SharedContext{}, err
		}
		result.UpstreamArtifacts = append(result.UpstreamArtifacts, refs...)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return SharedContext{}, err
	}
	for _, ref := range result.UpstreamArtifacts {
		var file sharedfiles.File
		if admin {
			file, err = s.Files.GetAdminFile(ctx, ref.FileID)
		} else {
			file, err = s.Files.GetFile(ctx, user, ref.FileID)
		}
		if err != nil {
			return SharedContext{}, fileAccessError(err)
		}
		if !matchesArtifact(file, ref) {
			return SharedContext{}, sharedfiles.ErrRevisionConflict
		}
	}
	return result, nil
}

type submission struct {
	Instance, Node, Type, Status, InstanceStatus, Key, Digest, HandledBy string
	Response                                                             json.RawMessage
}

func (s *Service) submission(ctx context.Context, id, user, agent string) (submission, error) {
	var item submission
	err := s.DB.QueryRow(ctx, `SELECT t.instance_id,t.node_id,t.type,t.status,i.status,COALESCE(t.complete_key,''),COALESCE(t.complete_digest,''),COALESCE(t.handled_by,''),t.complete_response_json FROM workflow_node_tasks t JOIN workflow_instances i ON i.id=t.instance_id WHERE t.id=$1 AND EXISTS(SELECT 1 FROM workflow_task_assignees a JOIN accounts u ON u.user_id=a.user_id AND u.status='active' WHERE a.task_id=t.id AND a.user_id=$2)`, id, user).Scan(&item.Instance, &item.Node, &item.Type, &item.Status, &item.InstanceStatus, &item.Key, &item.Digest, &item.HandledBy, &item.Response)
	if errors.Is(err, pgx.ErrNoRows) {
		return item, ErrMissing
	}
	if err != nil {
		return item, err
	}
	if (agent == "" && item.Type != "approval") || (agent != "" && item.Type != "agent") {
		return item, ErrForbidden
	}
	return item, nil
}

func (s *Service) archiveSubmission(ctx context.Context, id, user, agent, key, decision, comment string, output json.RawMessage, attachments []Artifact, requestDigest string) ([]Artifact, *Result, error) {
	if len(attachments) > 100 || (agent == "" && len(attachments) != 0) {
		return nil, nil, ErrInvalid
	}
	item, err := s.submission(ctx, id, user, agent)
	if err != nil {
		return nil, nil, err
	}
	if item.Status != "pending" {
		if item.Key != key || item.HandledBy != user || item.Digest != requestDigest || len(item.Response) == 0 {
			return nil, nil, ErrConflict
		}
		if _, err = s.readSharedContext(ctx, item.Instance, user); err != nil {
			return nil, nil, err
		}
		space, err := s.spaceForInstance(ctx, s.DB, item.Instance)
		if err != nil {
			return nil, nil, err
		}
		if space != "" {
			if err = s.Files.CheckSpaceAccess(ctx, user, space, sharedfiles.ActionWrite); err != nil {
				return nil, nil, fileAccessError(err)
			}
		}
		var result Result
		err = json.Unmarshal(item.Response, &result)
		return nil, &result, err
	}
	if item.InstanceStatus != "running" {
		return nil, nil, ErrConflict
	}
	space, err := s.initializeSharedFiles(ctx, item.Instance)
	if err != nil {
		return nil, nil, err
	}
	if s.Files == nil {
		return nil, nil, sharedfiles.ErrStorageUnavailable
	}
	if err = s.Files.CheckSpaceAccess(ctx, user, space, sharedfiles.ActionWrite); err != nil {
		return nil, nil, fileAccessError(err)
	}
	prefix, err := submissionPrefix(item.Instance, item.Node, user, key)
	if err != nil {
		return nil, nil, err
	}
	refs := []Artifact{}
	seen := map[string]bool{}
	for _, ref := range attachments {
		file, err := s.Files.GetFile(ctx, user, ref.FileID)
		if err != nil {
			return nil, nil, fileAccessError(err)
		}
		if seen[file.FileID] || file.SpaceID != space || file.CreatedByUserID != user || file.LogicalPath != prefix+"attachments/"+file.FileName || !matchesArtifact(file, ref) {
			return nil, nil, ErrConflict
		}
		seen[file.FileID] = true
		refs = append(refs, artifact(file))
	}
	if agent != "" {
		if _, err := s.archiveBytes(ctx, user, agent, space, prefix+"submission.sha256", "text/plain", []byte(requestDigest)); err != nil {
			if errors.Is(err, sharedfiles.ErrRevisionConflict) {
				return nil, nil, ErrConflict
			}
			return nil, nil, fileAccessError(err)
		}
	}
	if agent == "" {
		file, err := s.archiveApproval(ctx, user, space, prefix, decision, comment)
		if err != nil {
			return nil, nil, err
		}
		return append(refs, artifact(file)), nil, nil
	} else {
		var business map[string]json.RawMessage
		if err = json.Unmarshal(output, &business); err != nil {
			return nil, nil, ErrInvalid
		}
		var text string
		if raw, ok := business["text"]; ok && json.Unmarshal(raw, &text) == nil {
			file, err := s.archiveBytes(ctx, user, agent, space, prefix+"result.md", "text/markdown; charset=utf-8", []byte(text))
			if err != nil {
				return nil, nil, err
			}
			refs = append(refs, artifact(file))
		}
	}
	file, err := s.archiveBytes(ctx, user, agent, space, prefix+"result.json", "application/json", output)
	if err != nil {
		return nil, nil, err
	}
	return append(refs, artifact(file)), nil, nil
}

func (s *Service) archiveBytes(ctx context.Context, user, agent, space, logicalPath, contentType string, data []byte) (sharedfiles.File, error) {
	sum := sha256.Sum256(data)
	return s.Files.UploadOnce(ctx, user, agent, space, logicalPath, contentType, int64(len(data)), fmt.Sprintf("%x", sum), bytes.NewReader(data))
}

func (s *Service) archiveApproval(ctx context.Context, user, space, prefix, decision, comment string) (sharedfiles.File, error) {
	const maxDocumentBytes = 64 << 10
	type approvalDocument struct {
		Decision  string    `json:"decision"`
		Comment   string    `json:"comment"`
		HandledBy string    `json:"handled_by"`
		HandledAt time.Time `json:"handled_at"`
	}
	file, err := s.Files.GetFileByPath(ctx, user, space, prefix+"result.json")
	if errors.Is(err, sharedfiles.ErrSharedFileNotFound) {
		raw, marshalErr := json.Marshal(approvalDocument{decision, comment, user, time.Now().UTC()})
		if marshalErr != nil {
			return sharedfiles.File{}, marshalErr
		}
		file, err = s.archiveBytes(ctx, user, "", space, prefix+"result.json", "application/json", raw)
		if !errors.Is(err, sharedfiles.ErrRevisionConflict) {
			return file, err
		}
		file, err = s.Files.GetFileByPath(ctx, user, space, prefix+"result.json")
	}
	if err != nil {
		return sharedfiles.File{}, err
	}
	file, reader, err := s.Files.OpenFile(ctx, user, file.FileID)
	if err != nil {
		return sharedfiles.File{}, err
	}
	defer reader.Close()
	raw, err := io.ReadAll(io.LimitReader(reader, maxDocumentBytes+1))
	if err != nil {
		return sharedfiles.File{}, err
	}
	if len(raw) > maxDocumentBytes {
		return sharedfiles.File{}, ErrLarge
	}
	var existing approvalDocument
	if json.Unmarshal(raw, &existing) != nil || existing.Decision != decision || existing.Comment != comment || existing.HandledBy != user || existing.HandledAt.IsZero() || file.CreatedByUserID != user {
		return sharedfiles.File{}, ErrConflict
	}
	return file, nil
}

func (s *Service) validateArtifactsTx(ctx context.Context, tx pgx.Tx, user, space string, refs []Artifact) error {
	for _, ref := range refs {
		file, err := s.Files.GetFileTx(ctx, tx, user, ref.FileID)
		if err != nil {
			return fileAccessError(err)
		}
		if file.SpaceID != space || !matchesArtifact(file, ref) {
			return sharedfiles.ErrRevisionConflict
		}
	}
	return nil
}

func (s *Service) UploadAttachment(ctx context.Context, id, user, agent, key, filename, contentType string, size int64, sha256 string, source io.Reader) (Artifact, error) {
	if key == "" || len(key) > 200 || filename == "" || filename != path.Base(filename) || strings.ContainsAny(filename, "/\\") || filename == "." || filename == ".." {
		return Artifact{}, ErrInvalid
	}
	item, err := s.submission(ctx, id, user, agent)
	if err != nil {
		return Artifact{}, err
	}
	if item.Type != "agent" || item.Status != "pending" || item.InstanceStatus != "running" {
		return Artifact{}, ErrConflict
	}
	space, err := s.initializeSharedFiles(ctx, item.Instance)
	if err != nil {
		return Artifact{}, err
	}
	prefix, err := submissionPrefix(item.Instance, item.Node, user, key)
	if err != nil {
		return Artifact{}, err
	}
	file, err := s.Files.UploadOnce(ctx, user, agent, space, prefix+"attachments/"+filename, contentType, size, sha256, source)
	if err != nil {
		return Artifact{}, fileAccessError(err)
	}
	return artifact(file), nil
}

func sortArtifacts(refs []Artifact) []Artifact {
	refs = slices.Clone(refs)
	slices.SortFunc(refs, func(left, right Artifact) int { return strings.Compare(left.FileID, right.FileID) })
	return refs
}
