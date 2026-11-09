package workflow

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/sharedfiles"
)

func equalJSON(left, right json.RawMessage) bool {
	var first, second any
	return json.Unmarshal(left, &first) == nil && json.Unmarshal(right, &second) == nil && reflect.DeepEqual(first, second)
}

func TestWorkflowArtifactsAndRevocation(t *testing.T) {
	s := workflowTestService(t)
	ctx := context.Background()
	template := enabledWorkflow(t, s, []Node{{ID: "first", Type: "agent", Title: "生成", Instruction: "生成", AssigneeUsers: []string{"a", "b"}}, {ID: "review", Order: 1, Type: "approval", Title: "审批", Instruction: "审批", Assignee: "c"}})
	if template.SharedSpaceID == "" {
		t.Fatal("新模板必须绑定空间")
	}
	var spaceName string
	if err := s.DB.QueryRow(ctx, `SELECT name FROM shared_spaces WHERE space_id=$1`, template.SharedSpaceID).Scan(&spaceName); err != nil || spaceName != "工作流-共同待办" {
		t.Fatalf("workflow space name=%q err=%v", spaceName, err)
	}
	saved, err := s.Save(ctx, "a", template.ID, "改名", "", template.Revision, template.Nodes)
	if err != nil || saved.SharedSpaceID != template.SharedSpaceID {
		t.Fatalf("保存复用空间: %+v %v", saved, err)
	}
	started, err := s.Start(ctx, template.ID, "b", "start", json.RawMessage(`{"text":"输入"}`))
	if err != nil {
		t.Fatal(err)
	}
	if started.SharedSpaceID != template.SharedSpaceID || started.InstancePathPrefix != instancePrefix(started.InstanceID) {
		t.Fatal(started)
	}
	for _, user := range []string{"a", "b", "c"} {
		if err := s.Files.CheckSpaceAccess(ctx, user, template.SharedSpaceID, sharedfiles.ActionWrite); err != nil {
			t.Fatal(user, err)
		}
	}
	content := "附件内容"
	sum := sha256.Sum256([]byte(content))
	ref, err := s.UploadAttachment(ctx, started.TaskID, "b", "agent-b", "done", "说明.txt", "text/plain", int64(len(content)), fmt.Sprintf("%x", sum), strings.NewReader(content))
	if err != nil {
		t.Fatal(err)
	}
	if retry, err := s.UploadAttachment(ctx, started.TaskID, "b", "agent-b", "done", "说明.txt", "text/plain", int64(len(content)), fmt.Sprintf("%x", sum), strings.NewReader(content)); err != nil || retry != ref {
		t.Fatalf("附件复用: %+v %v", retry, err)
	}
	if _, err := s.UploadAttachment(ctx, started.TaskID, "b", "agent-b", "done", "../越界.txt", "text/plain", 0, fmt.Sprintf("%x", sum), strings.NewReader("")); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
	output := json.RawMessage(`{"text":"正式文本","score":17}`)
	if _, err := s.Complete(ctx, started.TaskID, "b", "agent-b", "wrong-submission", "", "", output, ref); !errors.Is(err, ErrConflict) {
		t.Fatalf("其他提交附件不能引用: %v", err)
	}
	completed, err := s.Complete(ctx, started.TaskID, "b", "agent-b", "done", "", "", output, ref)
	if err != nil || completed.NextTask == nil {
		t.Fatal(completed, err)
	}
	if replay, err := s.Complete(ctx, started.TaskID, "b", "agent-b", "done", "", "", output, ref); err != nil || replay.InstanceID != completed.InstanceID {
		t.Fatal(replay, err)
	}
	if _, err := s.Complete(ctx, started.TaskID, "b", "agent-b", "done", "", "", json.RawMessage(`{"text":"修改"}`), ref); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	if _, err := s.Complete(ctx, started.TaskID, "a", "agent-a", "done", "", "", output); !errors.Is(err, ErrConflict) {
		t.Fatalf("未获胜候选不能提交: %v", err)
	}
	task, err := s.Task(ctx, completed.NextTask.ID, "c", "approval")
	if err != nil || len(task.UpstreamArtifacts) != 3 || !equalJSON(task.Input, output) {
		t.Fatal(task, err)
	}
	for _, fileRef := range task.UpstreamArtifacts {
		file, reader, err := s.Files.OpenFile(ctx, "c", fileRef.FileID)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(reader)
		reader.Close()
		if err != nil || !matchesArtifact(file, fileRef) {
			t.Fatal(file, err)
		}
		if file.FileName == "result.md" && string(data) != "正式文本" {
			t.Fatal(string(data))
		}
		if file.FileName == "result.json" && string(data) != string(output) {
			t.Fatal(string(data))
		}
	}
	if err := s.Files.RemoveMember(ctx, template.SharedSpaceID, "c"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Task(ctx, completed.NextTask.ID, "c", "approval"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("撤权后不能读取正文: %v", err)
	}
	if _, err := s.Instance(ctx, started.InstanceID, "c", false); !errors.Is(err, ErrForbidden) {
		t.Fatalf("实例详情不能绕过撤权: %v", err)
	}
	if _, err := s.Complete(ctx, completed.NextTask.ID, "c", "", "approve", "approve", "意见", nil); !errors.Is(err, ErrForbidden) {
		t.Fatalf("审批不能绕过撤权: %v", err)
	}
	list, _, err := s.Instances(ctx, "c", false, "running", 20, "")
	if err != nil || len(list) != 1 || len(list[0].InitialInput) != 0 {
		t.Fatalf("撤权后仍可读状态但不能读正文: %+v %v", list, err)
	}
	if _, err := s.Files.AddMember(ctx, template.SharedSpaceID, "c", "a"); err != nil {
		t.Fatal(err)
	}
	approved, err := s.Complete(ctx, completed.NextTask.ID, "c", "", "approve", "approve", "意见", nil)
	if err != nil || approved.Status != "succeeded" {
		t.Fatal(approved, err)
	}
	instance, err := s.Instance(ctx, started.InstanceID, "c", false)
	if err != nil || len(instance.Tasks[1].Artifacts) != 1 || !equalJSON(instance.Tasks[1].Output, output) {
		t.Fatal(instance, err)
	}
	_, reader, err := s.Files.OpenFile(ctx, "a", instance.Tasks[1].Artifacts[0].FileID)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	var approval map[string]any
	if err := json.NewDecoder(reader).Decode(&approval); err != nil || approval["decision"] != "approve" || approval["comment"] != "意见" || approval["handled_by"] != "c" || approval["handled_at"] == nil {
		t.Fatal(approval, err)
	}
	if _, err := s.Instance(ctx, started.InstanceID, "other", true); !errors.Is(err, ErrForbidden) {
		t.Fatalf("工作流管理权不代表网盘读取权: %v", err)
	}
	if _, err := s.Instance(ctx, started.InstanceID, "other", true, true); err != nil {
		t.Fatal(err)
	}
}

func TestWorkflowDuplicateTemplateNamesUseTimestampSuffix(t *testing.T) {
	s := workflowTestService(t)
	ctx := context.Background()
	first, err := s.Save(ctx, "a", "", "同名模板", "", 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.Save(ctx, "a", "", "同名模板", "", 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	rows, err := s.DB.Query(ctx, `SELECT name FROM shared_spaces WHERE space_id IN ($1,$2) ORDER BY name`, first.SharedSpaceID, second.SharedSpaceID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		names = append(names, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(names) != 2 || names[0] != "工作流-同名模板" || !strings.HasPrefix(names[1], "工作流-同名模板-") {
		t.Fatalf("workflow names=%v", names)
	}
}

func TestWorkflowReadOnlyMembershipAndFileRevision(t *testing.T) {
	s := workflowTestService(t)
	ctx := context.Background()
	template := enabledWorkflow(t, s, []Node{{ID: "first", Type: "agent", Title: "执行", Instruction: "执行", Assignee: "a"}, {ID: "last", Order: 1, Type: "agent", Title: "收尾", Instruction: "收尾", Assignee: "b"}})
	if _, err := s.Files.AddMemberWithActions(ctx, template.SharedSpaceID, "b", []string{sharedfiles.ActionRead}, "a"); err != nil {
		t.Fatal(err)
	}
	started, err := s.Start(ctx, template.ID, "a", "start", nil)
	if err != nil {
		t.Fatal(err)
	}
	completed, err := s.Complete(ctx, started.TaskID, "a", "agent-a", "done", "", "", json.RawMessage(`{"text":"内容"}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Complete(ctx, completed.NextTask.ID, "b", "agent-b", "done", "", "", nil); !errors.Is(err, ErrForbidden) {
		t.Fatalf("只读成员不提升为可写: %v", err)
	}
	if _, err := s.Start(ctx, template.ID, "a", "next", nil); err != nil {
		t.Fatal(err)
	}
	if err := s.Files.CheckSpaceAccess(ctx, "b", template.SharedSpaceID, sharedfiles.ActionWrite); err == nil {
		t.Fatal("新实例不覆盖只读权限")
	}
	instance, err := s.Instance(ctx, started.InstanceID, "b", false)
	if err != nil {
		t.Fatal(err)
	}
	ref := instance.Tasks[0].Artifacts[0]
	data := "被修改"
	sum := sha256.Sum256([]byte(data))
	if _, err := s.Files.Upload(ctx, "a", "agent-a", template.SharedSpaceID, ref.LogicalPath, "text/plain", int64(len(data)), fmt.Sprintf("%x", sum), &ref.Revision, strings.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Task(ctx, completed.NextTask.ID, "b", "agent"); !errors.Is(err, sharedfiles.ErrRevisionConflict) {
		t.Fatalf("上游文件被改后不能静默读取: %v", err)
	}
	if err := s.Files.RemoveMember(ctx, template.SharedSpaceID, "b"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Start(ctx, template.ID, "a", "rejoin", nil); err != nil {
		t.Fatal(err)
	}
	if err := s.Files.CheckSpaceAccess(ctx, "b", template.SharedSpaceID, sharedfiles.ActionWrite); err != nil {
		t.Fatalf("新实例按参与者重新加入: %v", err)
	}
}

type failingWorkflowStorage struct{ sharedfiles.Storage }

func (failingWorkflowStorage) Put(context.Context, string, io.Reader, sharedfiles.PutOptions) (sharedfiles.ObjectMetadata, error) {
	return sharedfiles.ObjectMetadata{}, sharedfiles.ErrStorageUnavailable
}

func TestWorkflowArchiveFailureDoesNotAdvance(t *testing.T) {
	s := workflowTestService(t)
	ctx := context.Background()
	template := enabledWorkflow(t, s, []Node{{ID: "review", Type: "approval", Title: "审批", Instruction: "审批", Assignee: "a"}, {ID: "agent", Order: 1, Type: "agent", Title: "执行", Instruction: "执行", Assignee: "b"}})
	started, err := s.Start(ctx, template.ID, "a", "start", nil)
	if err != nil {
		t.Fatal(err)
	}
	s.Files = sharedfiles.NewService(sharedfiles.NewPostgresStore(s.DB), failingWorkflowStorage{}, nil)
	if _, err := s.Complete(ctx, started.TaskID, "a", "", "approve", "approve", "", nil); !errors.Is(err, sharedfiles.ErrStorageUnavailable) {
		t.Fatal(err)
	}
	var status string
	var count int
	if err := s.DB.QueryRow(ctx, `SELECT status,(SELECT count(*) FROM workflow_node_tasks WHERE instance_id=$1) FROM workflow_instances WHERE id=$1`, started.InstanceID).Scan(&status, &count); err != nil || status != "running" || count != 1 {
		t.Fatal(status, count, err)
	}
}

func TestLegacyWorkflowFilesInitializeOnce(t *testing.T) {
	s := workflowTestService(t)
	ctx := context.Background()
	template := enabledWorkflow(t, s, []Node{{ID: "first", Type: "agent", Title: "执行", Instruction: "执行", Assignee: "a"}, {ID: "last", Order: 1, Type: "agent", Title: "收尾", Instruction: "收尾", Assignee: "b"}})
	started, err := s.Start(ctx, template.ID, "a", "legacy", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.DB.Exec(ctx, `UPDATE workflow_templates SET shared_space_id=NULL WHERE id=$1`, template.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.DB.Exec(ctx, `UPDATE shared_spaces SET name='legacy fixture' WHERE space_id=$1`, template.SharedSpaceID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.DB.Exec(ctx, `UPDATE workflow_instances SET shared_files_initialized=false WHERE id=$1`, started.InstanceID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Instance(ctx, started.InstanceID, "b", false); err != nil {
		t.Fatalf("旧实例详情兼容: %v", err)
	}
	space, err := s.initializeSharedFiles(ctx, started.InstanceID)
	if err != nil || space == "" || space == template.SharedSpaceID {
		t.Fatal(space, err)
	}
	for _, user := range []string{"a", "b"} {
		if err = s.Files.CheckSpaceAccess(ctx, user, space, sharedfiles.ActionWrite); err != nil {
			t.Fatal(user, err)
		}
	}
	if err = s.Files.RemoveMember(ctx, space, "b"); err != nil {
		t.Fatal(err)
	}
	if replay, err := s.initializeSharedFiles(ctx, started.InstanceID); err != nil || replay != space {
		t.Fatal(replay, err)
	}
	if err = s.Files.CheckSpaceAccess(ctx, "b", space, sharedfiles.ActionRead); !errors.Is(err, sharedfiles.ErrSharedSpaceNotFound) {
		t.Fatalf("初始化重试不能自动补权: %v", err)
	}
	if _, err = s.DB.Exec(ctx, `UPDATE workflow_templates SET shared_space_id=NULL WHERE id=$1`, template.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.DB.Exec(ctx, `UPDATE workflow_instances SET shared_files_initialized=false,status='terminated' WHERE id=$1`, started.InstanceID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.initializeSharedFiles(ctx, started.InstanceID); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	var boundSpace string
	if err = s.DB.QueryRow(ctx, `SELECT COALESCE(shared_space_id,'') FROM workflow_templates WHERE id=$1`, template.ID).Scan(&boundSpace); err != nil || boundSpace != "" {
		t.Fatalf("已结束旧实例不补建空间: %s %v", boundSpace, err)
	}
}

func legacyWorkflowFixture(t *testing.T, bind string) (*Service, Template, Result) {
	t.Helper()
	s := workflowTestService(t)
	ctx := context.Background()
	template := enabledWorkflow(t, s, []Node{{ID: "review", Type: "approval", Title: "审批", Instruction: "审批", AssigneeUsers: []string{"a", "b"}}, {ID: "last", Order: 1, Type: "agent", Title: "执行", Instruction: "执行", Assignee: "c"}})
	started, err := s.Start(ctx, template.ID, "a", "legacy", json.RawMessage(`{"legacy":true}`))
	if err != nil {
		t.Fatal(err)
	}
	nodes := []Node{{ID: "new", Type: "approval", Title: "新审批", Instruction: "新审批", Assignee: "a"}}
	definition, err := json.Marshal(nodes)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.DB.Exec(ctx, `UPDATE workflow_templates SET shared_space_id=NULL,definition_json=$2 WHERE id=$1`, template.ID, definition); err != nil {
		t.Fatal(err)
	}
	if _, err = s.DB.Exec(ctx, `UPDATE shared_spaces SET name='legacy fixture' WHERE space_id=$1`, template.SharedSpaceID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.DB.Exec(ctx, `UPDATE workflow_instances SET shared_files_initialized=false WHERE id=$1`, started.InstanceID); err != nil {
		t.Fatal(err)
	}
	switch bind {
	case "save":
		if _, err = s.Save(ctx, "a", template.ID, template.Name, "", template.Revision, nodes); err != nil {
			t.Fatal(err)
		}
	case "start":
		if _, err = s.Start(ctx, template.ID, "a", "new", nil); err != nil {
			t.Fatal(err)
		}
	}
	return s, template, started
}

func TestLegacyWorkflowReadsInitializeAfterTemplateBinding(t *testing.T) {
	for _, bind := range []string{"save", "start"} {
		for _, entry := range []string{"task", "instance", "approval", "initiated"} {
			t.Run(bind+"/"+entry, func(t *testing.T) {
				s, _, started := legacyWorkflowFixture(t, bind)
				ctx := context.Background()
				user := "b"
				if entry == "initiated" {
					user = "a"
				}
				read := func(user string) (SharedContext, error) {
					switch entry {
					case "task":
						item, err := s.Task(ctx, started.TaskID, user, "approval")
						return item.SharedContext, err
					case "instance":
						item, err := s.Instance(ctx, started.InstanceID, user, false)
						return item.SharedContext, err
					case "approval":
						_, item, _, err := s.Approval(ctx, user, "workflow", started.TaskID)
						return item.SharedContext, err
					default:
						_, item, _, err := s.Approval(ctx, user, "workflow_instance", started.InstanceID)
						return item.SharedContext, err
					}
				}
				if _, err := read("other"); !errors.Is(err, ErrMissing) {
					t.Fatalf("非参与者不能触发初始化: %v", err)
				}
				var initialized bool
				if err := s.DB.QueryRow(ctx, `SELECT shared_files_initialized FROM workflow_instances WHERE id=$1`, started.InstanceID).Scan(&initialized); err != nil || initialized {
					t.Fatalf("越权读取不能初始化: %v %v", initialized, err)
				}
				item, err := read(user)
				if err != nil || item.SharedSpaceID == "" {
					t.Fatalf("旧实例首次读取初始化: %+v %v", item, err)
				}
				if err := s.DB.QueryRow(ctx, `SELECT shared_files_initialized FROM workflow_instances WHERE id=$1`, started.InstanceID).Scan(&initialized); err != nil || !initialized {
					t.Fatalf("必须保存初始化标记: %v %v", initialized, err)
				}
				for _, participant := range []string{"a", "b", "c"} {
					if err := s.Files.CheckSpaceAccess(ctx, participant, item.SharedSpaceID, sharedfiles.ActionWrite); err != nil {
						t.Fatal(participant, err)
					}
				}
				if err := s.Files.RemoveMember(ctx, item.SharedSpaceID, user); err != nil {
					t.Fatal(err)
				}
				if _, err := read(user); !errors.Is(err, ErrForbidden) {
					t.Fatalf("初始化后读取不能补回撤销权限: %v", err)
				}
				if err := s.Files.CheckSpaceAccess(ctx, user, item.SharedSpaceID, sharedfiles.ActionRead); !errors.Is(err, sharedfiles.ErrSharedSpaceNotFound) {
					t.Fatalf("撤销权限必须保持: %v", err)
				}
			})
		}
	}
}

func TestLegacyEndedWorkflowReadsWithoutBackfill(t *testing.T) {
	for _, bind := range []string{"", "save"} {
		for _, status := range []string{"succeeded", "rejected", "terminated"} {
			t.Run(bind+"/"+status, func(t *testing.T) {
				s, template, started := legacyWorkflowFixture(t, bind)
				ctx := context.Background()
				if _, err := s.DB.Exec(ctx, `UPDATE workflow_instances SET status=$2,current_node_id=NULL,ended_at=now() WHERE id=$1`, started.InstanceID, status); err != nil {
					t.Fatal(err)
				}
				if _, err := s.DB.Exec(ctx, `UPDATE workflow_node_tasks SET status='completed',output_json='{"legacy":true}' WHERE id=$1`, started.TaskID); err != nil {
					t.Fatal(err)
				}
				var beforeSpaces, beforeGrants int
				if err := s.DB.QueryRow(ctx, `SELECT (SELECT count(*) FROM shared_spaces),(SELECT count(*) FROM data_resource_grants)`).Scan(&beforeSpaces, &beforeGrants); err != nil {
					t.Fatal(err)
				}
				instance, err := s.Instance(ctx, started.InstanceID, "b", false)
				if err != nil || len(instance.Tasks) != 1 || !equalJSON(instance.Tasks[0].Output, json.RawMessage(`{"legacy":true}`)) {
					t.Fatalf("旧结束实例保留正文读取: %+v %v", instance, err)
				}
				if _, _, task, err := s.Approval(ctx, "b", "workflow", started.TaskID); err != nil || task == nil {
					t.Fatalf("旧结束审批详情兼容: %+v %v", task, err)
				}
				if _, _, _, err := s.Approval(ctx, "a", "workflow_instance", started.InstanceID); err != nil {
					t.Fatalf("旧发起审批详情兼容: %v", err)
				}
				var initialized bool
				var afterSpaces, afterGrants, files int
				var space string
				if err := s.DB.QueryRow(ctx, `SELECT shared_files_initialized,(SELECT count(*) FROM shared_spaces),(SELECT count(*) FROM data_resource_grants),(SELECT count(*) FROM shared_files),COALESCE((SELECT shared_space_id FROM workflow_templates WHERE id=$2),'') FROM workflow_instances WHERE id=$1`, started.InstanceID, template.ID).Scan(&initialized, &afterSpaces, &afterGrants, &files, &space); err != nil {
					t.Fatal(err)
				}
				if initialized || afterSpaces != beforeSpaces || afterGrants != beforeGrants || files != 0 || (bind == "" && space != "") {
					t.Fatalf("结束实例不得初始化、授权或归档: %v %d/%d %d/%d %d %s", initialized, afterSpaces, beforeSpaces, afterGrants, beforeGrants, files, space)
				}
			})
		}
	}
}

type workflowArchiveUpload struct {
	data    []byte
	release chan struct{}
}

type concurrentWorkflowStorage struct {
	sharedfiles.Storage
	uploads chan workflowArchiveUpload
}

func (s concurrentWorkflowStorage) Put(ctx context.Context, key string, source io.Reader, options sharedfiles.PutOptions) (sharedfiles.ObjectMetadata, error) {
	data, err := io.ReadAll(source)
	if err != nil {
		return sharedfiles.ObjectMetadata{}, err
	}
	upload := workflowArchiveUpload{data: data, release: make(chan struct{})}
	select {
	case s.uploads <- upload:
	case <-ctx.Done():
		return sharedfiles.ObjectMetadata{}, ctx.Err()
	}
	select {
	case <-upload.release:
	case <-ctx.Done():
		return sharedfiles.ObjectMetadata{}, ctx.Err()
	}
	return s.Storage.Put(ctx, key, strings.NewReader(string(data)), options)
}

func TestWorkflowConcurrentApprovalArchive(t *testing.T) {
	for _, test := range []struct {
		name, decision, comment string
		conflict                bool
	}{
		{"相同提交", "approve", "意见", false},
		{"不同决定", "reject", "意见", true},
		{"不同意见", "approve", "不同意见", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := workflowTestService(t)
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			template := enabledWorkflow(t, s, []Node{{ID: "review", Type: "approval", Title: "审批", Instruction: "审批", Assignee: "a"}, {ID: "last", Order: 1, Type: "agent", Title: "执行", Instruction: "执行", Assignee: "b"}})
			started, err := s.Start(ctx, template.ID, "a", "start", nil)
			if err != nil {
				t.Fatal(err)
			}
			storage, err := sharedfiles.NewFileSystemStorage(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			uploads := make(chan workflowArchiveUpload, 2)
			s.Files = sharedfiles.NewService(sharedfiles.NewPostgresStore(s.DB), concurrentWorkflowStorage{Storage: storage, uploads: uploads}, nil)
			type completed struct {
				result Result
				err    error
			}
			results := make(chan completed, 2)
			complete := func(decision, comment string) {
				result, err := s.Complete(ctx, started.TaskID, "a", "", "same", decision, comment, nil)
				results <- completed{result, err}
			}
			awaitUpload := func() workflowArchiveUpload {
				select {
				case upload := <-uploads:
					return upload
				case <-ctx.Done():
					t.Fatal("未到达首次归档上传", ctx.Err())
					return workflowArchiveUpload{}
				}
			}
			go complete("approve", "意见")
			firstUpload := awaitUpload()
			go complete(test.decision, test.comment)
			secondUpload := awaitUpload()
			var firstDocument, secondDocument struct {
				HandledAt time.Time `json:"handled_at"`
			}
			if json.Unmarshal(firstUpload.data, &firstDocument) != nil || json.Unmarshal(secondUpload.data, &secondDocument) != nil || firstDocument.HandledAt.Equal(secondDocument.HandledAt) {
				t.Fatal("必须生成不同 handled_at 的并发首次档案")
			}
			close(firstUpload.release)
			first := <-results
			if first.err != nil || first.result.NextTask == nil {
				t.Fatal(first)
			}
			var winnerArtifacts []byte
			if err := s.DB.QueryRow(ctx, `SELECT artifacts_json FROM workflow_node_tasks WHERE id=$1`, started.TaskID).Scan(&winnerArtifacts); err != nil {
				t.Fatal(err)
			}
			close(secondUpload.release)
			second := <-results
			firstResponse, _ := json.Marshal(first.result)
			secondResponse, _ := json.Marshal(second.result)
			if test.conflict {
				if !errors.Is(second.err, ErrConflict) {
					t.Fatalf("同键不同内容必须冲突: %+v %v", second.result, second.err)
				}
			} else if second.err != nil || !equalJSON(firstResponse, secondResponse) {
				t.Fatalf("并发相同审批必须复用结果: %+v %+v %v", first.result, second.result, second.err)
			}
			var files, tasks, events int
			var artifacts []byte
			if err := s.DB.QueryRow(ctx, `SELECT (SELECT count(*) FROM shared_files),(SELECT count(*) FROM workflow_node_tasks WHERE instance_id=$2),(SELECT count(*) FROM workflow_events WHERE task_id=$1 AND event_type='task_completed'),artifacts_json FROM workflow_node_tasks WHERE id=$1`, started.TaskID, started.InstanceID).Scan(&files, &tasks, &events, &artifacts); err != nil || files != 1 || tasks != 2 || events != 1 || string(artifacts) != string(winnerArtifacts) {
				t.Fatalf("只能归档并推进一次，引用不得变化: %d %d %d %s %v", files, tasks, events, artifacts, err)
			}
			var refs []Artifact
			if err := json.Unmarshal(artifacts, &refs); err != nil || len(refs) != 1 || refs[0].Revision != 1 {
				t.Fatal(refs, err)
			}
			file, reader, err := s.Files.OpenFile(ctx, "a", refs[0].FileID)
			if err != nil {
				t.Fatal(err)
			}
			data, err := io.ReadAll(reader)
			reader.Close()
			if err != nil || string(data) != string(firstUpload.data) || !matchesArtifact(file, refs[0]) {
				t.Fatalf("必须保留胜出时间、正文和文件引用: %s %v", data, err)
			}
		})
	}
}

func TestWorkflowApprovalArchiveRejectsForeignAccounts(t *testing.T) {
	s := workflowTestService(t)
	ctx := context.Background()
	template := enabledWorkflow(t, s, []Node{{ID: "review", Type: "approval", Title: "审批", Instruction: "审批", AssigneeUsers: []string{"a", "b"}}})
	for _, test := range []struct {
		name, creator, handledBy string
	}{
		{"文件账户不同", "b", "a"},
		{"档案账户不同", "a", "b"},
	} {
		t.Run(test.name, func(t *testing.T) {
			started, err := s.Start(ctx, template.ID, "a", test.name, nil)
			if err != nil {
				t.Fatal(err)
			}
			prefix, err := submissionPrefix(started.InstanceID, "review", "a", "approve")
			if err != nil {
				t.Fatal(err)
			}
			raw, err := json.Marshal(map[string]any{"decision": "approve", "comment": "意见", "handled_by": test.handledBy, "handled_at": time.Now().UTC()})
			if err != nil {
				t.Fatal(err)
			}
			file, err := s.archiveBytes(ctx, test.creator, "", template.SharedSpaceID, prefix+"result.json", "application/json", raw)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.Complete(ctx, started.TaskID, "a", "", "approve", "approve", "意见", nil); !errors.Is(err, ErrConflict) {
				t.Fatalf("账户不匹配不能复用档案: %v", err)
			}
			current, err := s.Files.GetFile(ctx, "a", file.FileID)
			if err != nil || !matchesArtifact(current, artifact(file)) {
				t.Fatalf("冲突不得覆盖档案: %+v %v", current, err)
			}
			var status string
			var artifacts []byte
			if err := s.DB.QueryRow(ctx, `SELECT status,artifacts_json FROM workflow_node_tasks WHERE id=$1`, started.TaskID).Scan(&status, &artifacts); err != nil || status != "pending" || string(artifacts) != "[]" {
				t.Fatalf("冲突不得推进或保存引用: %s %s %v", status, artifacts, err)
			}
		})
	}
}

func TestWorkflowAutomaticMembershipPreservesConcurrentReadOnlyGrant(t *testing.T) {
	service := workflowTestService(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	template := enabledWorkflow(t, service, []Node{{ID: "agent", Type: "agent", Title: "执行", Instruction: "执行", Assignee: "a"}})
	manual, err := service.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer manual.Rollback(ctx)
	if _, err := manual.Exec(ctx, `SELECT user_id FROM accounts WHERE user_id='b' FOR SHARE`); err != nil {
		t.Fatal(err)
	}
	if _, err := manual.Exec(ctx, `INSERT INTO data_resource_grants(grant_id,user_id,resource_type,resource_id,action,created_by,created_at,updated_at) VALUES('manual-read','b',$1,$2,$3,'other',now(),now())`, sharedfiles.ResourceTypeSharedSpace, template.SharedSpaceID, sharedfiles.ActionRead); err != nil {
		t.Fatal(err)
	}
	automatic, err := service.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer automatic.Rollback(ctx)
	var automaticPID int
	if err := automatic.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&automaticPID); err != nil {
		t.Fatal(err)
	}
	completed := make(chan error, 1)
	go func() {
		err := service.Files.EnsureMembersTx(ctx, automatic, template.SharedSpaceID, []string{"b"}, "a")
		if err == nil {
			err = automatic.Commit(ctx)
		}
		completed <- err
	}()
	for {
		var blocked bool
		if err := service.DB.QueryRow(ctx, `SELECT cardinality(pg_blocking_pids($1))>0`, automaticPID).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
	if err := manual.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-completed; err != nil {
		t.Fatal(err)
	}
	if err := service.Files.CheckSpaceAccess(ctx, "b", template.SharedSpaceID, sharedfiles.ActionRead); err != nil {
		t.Fatal(err)
	}
	if err := service.Files.CheckSpaceAccess(ctx, "b", template.SharedSpaceID, sharedfiles.ActionWrite); !errors.Is(err, sharedfiles.ErrSharedSpaceNotFound) {
		t.Fatalf("并发手工只读授权不得被提升为可写: %v", err)
	}
}

func TestWorkflowAutomaticMembershipCompatibleWithForeignKeyLocks(t *testing.T) {
	service := workflowTestService(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	template := enabledWorkflow(t, service, []Node{{ID: "agent", Type: "agent", Title: "执行", Instruction: "执行", Assignee: "a"}})
	foreignKey, err := service.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer foreignKey.Rollback(ctx)
	if _, err := foreignKey.Exec(ctx, `SELECT user_id FROM accounts WHERE user_id='b' FOR KEY SHARE`); err != nil {
		t.Fatal(err)
	}
	automatic, err := service.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer automatic.Rollback(ctx)
	if _, err := automatic.Exec(ctx, `SELECT user_id FROM accounts WHERE user_id='b' FOR KEY SHARE`); err != nil {
		t.Fatal(err)
	}
	if err := service.Files.EnsureMembersTx(ctx, automatic, template.SharedSpaceID, []string{"b"}, "a"); err != nil {
		t.Fatalf("自动成员授权不得等待已有外键锁: %v", err)
	}
	if err := automatic.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := service.Files.CheckSpaceAccess(ctx, "b", template.SharedSpaceID, sharedfiles.ActionWrite); err != nil {
		t.Fatal(err)
	}
}

func blockWorkflowCompletion(t *testing.T, service *Service) func() {
	t.Helper()
	ctx := context.Background()
	if _, err := service.DB.Exec(ctx, `CREATE FUNCTION block_workflow_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated completion failure'; END $$;
CREATE TRIGGER block_workflow_completion BEFORE UPDATE ON workflow_node_tasks FOR EACH ROW EXECUTE FUNCTION block_workflow_completion()`); err != nil {
		t.Fatal(err)
	}
	return func() {
		t.Helper()
		if _, err := service.DB.Exec(ctx, `DROP TRIGGER block_workflow_completion ON workflow_node_tasks`); err != nil {
			t.Fatal(err)
		}
	}
}

func TestWorkflowSubmissionRetryAfterFailedCommit(t *testing.T) {
	for _, test := range []struct {
		name                             string
		firstAttachment, retryAttachment bool
		conflict                         bool
	}{
		{"原请求重试", true, true, false},
		{"删除附件", true, false, true},
		{"新增附件", false, true, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := workflowTestService(t)
			ctx := context.Background()
			template := enabledWorkflow(t, service, []Node{{ID: "agent", Type: "agent", Title: "执行", Instruction: "执行", Assignee: "a"}})
			started, err := service.Start(ctx, template.ID, "a", "start", nil)
			if err != nil {
				t.Fatal(err)
			}
			content := "附件"
			sum := sha256.Sum256([]byte(content))
			ref, err := service.UploadAttachment(ctx, started.TaskID, "a", "agent-a", "same-key", "report.txt", "text/plain", int64(len(content)), fmt.Sprintf("%x", sum), strings.NewReader(content))
			if err != nil {
				t.Fatal(err)
			}
			var first, retry []Artifact
			if test.firstAttachment {
				first = []Artifact{ref}
			}
			if test.retryAttachment {
				retry = []Artifact{ref}
			}
			output := json.RawMessage(`{"text":"正式结果"}`)
			unblock := blockWorkflowCompletion(t, service)
			if _, err := service.Complete(ctx, started.TaskID, "a", "agent-a", "same-key", "", "", output, first...); err == nil || !strings.Contains(err.Error(), "simulated completion failure") {
				t.Fatalf("应在归档成功后模拟完成事务失败: %v", err)
			}
			unblock()
			result, err := service.Complete(ctx, started.TaskID, "a", "agent-a", "same-key", "", "", output, retry...)
			if test.conflict {
				if !errors.Is(err, ErrConflict) {
					t.Fatalf("同键改变附件必须冲突: %+v %v", result, err)
				}
				if _, err := service.Complete(ctx, started.TaskID, "a", "agent-a", "same-key", "", "", output, first...); err != nil {
					t.Fatalf("冲突后仍应允许原请求重试: %v", err)
				}
			} else if err != nil || result.Status != "succeeded" {
				t.Fatalf("原请求应复用归档并完成: %+v %v", result, err)
			}
		})
	}
}

func TestWorkflowApprovalArchiveRetryWithEscapedComment(t *testing.T) {
	service := workflowTestService(t)
	ctx := context.Background()
	template := enabledWorkflow(t, service, []Node{{ID: "approval", Type: "approval", Title: "审批", Instruction: "审批", Assignee: "a"}})
	started, err := service.Start(ctx, template.ID, "a", "start", nil)
	if err != nil {
		t.Fatal(err)
	}
	comment := strings.Repeat("<", 4096)
	unblock := blockWorkflowCompletion(t, service)
	if _, err := service.Complete(ctx, started.TaskID, "a", "", "same-key", "approve", comment, nil); err == nil || !strings.Contains(err.Error(), "simulated completion failure") {
		t.Fatalf("应在归档成功后模拟完成事务失败: %v", err)
	}
	unblock()
	result, err := service.Complete(ctx, started.TaskID, "a", "", "same-key", "approve", comment, nil)
	if err != nil || result.Status != "succeeded" {
		t.Fatalf("合法审批意见转义后仍应允许原请求重试: %+v %v", result, err)
	}
}

func TestWorkflowApprovalArchiveRejectsOversizedDocument(t *testing.T) {
	service := workflowTestService(t)
	ctx := context.Background()
	template := enabledWorkflow(t, service, []Node{{ID: "approval", Type: "approval", Title: "审批", Instruction: "审批", Assignee: "a"}})
	started, err := service.Start(ctx, template.ID, "a", "start", nil)
	if err != nil {
		t.Fatal(err)
	}
	prefix, err := submissionPrefix(started.InstanceID, "approval", "a", "same-key")
	if err != nil {
		t.Fatal(err)
	}
	document, err := json.Marshal(map[string]any{"decision": "approve", "comment": "", "handled_by": "a", "handled_at": time.Now().UTC()})
	if err != nil {
		t.Fatal(err)
	}
	document = append(document, []byte(strings.Repeat(" ", 64<<10))...)
	if _, err := service.archiveBytes(ctx, "a", "", template.SharedSpaceID, prefix+"result.json", "application/json", document); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Complete(ctx, started.TaskID, "a", "", "same-key", "approve", "", nil); !errors.Is(err, ErrLarge) {
		t.Fatalf("超限审批档案应明确拒绝: %v", err)
	}
}
