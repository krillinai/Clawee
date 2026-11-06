package skillcontributionsmcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/krillinai/Clawee/server/internal/dataaccess"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

func TestContributionToolsAuthorizeCallerAndReturnControlledDownload(t *testing.T) {
	ctx:=context.Background()
	access:=dataaccess.NewService(dataaccess.NewMemoryStore())
	client:=&Client{Service:skillhub.NewService(skillhub.Config{Store:skillhub.NewMemoryStore(),PackageRoot:t.TempDir()}),Access:access}
	tools,err:=client.ListTools(ctx,mcpgateway.UpstreamServer{},"")
	if err!=nil || len(tools)!=2{t.Fatal("首版只提供两个工具",err)}
	call:=func(tool string,args mcpgateway.JSONMap)mcpgateway.UpstreamCallResult{t.Helper();result,err:=client.CallTool(ctx,mcpgateway.UpstreamCallRequest{Capability:mcpgateway.Capability{UpstreamName:tool},Caller:mcpgateway.AgentIdentity{UserID:"hr"},Arguments:args});if err!=nil{t.Fatal(err)};return result}
	if result:=call(ToolQuery,mcpgateway.JSONMap{});!result.IsError{t.Fatal("未授权查询成功")}
	if _,err=access.Create(ctx,dataaccess.SetInput{UserID:"hr",ResourceType:dataaccess.ResourceDataView,ResourceID:dataaccess.ViewSkillContributions,Actions:[]string{dataaccess.ActionRead},CreatedBy:"admin"});err!=nil{t.Fatal(err)}
	for _,args:=range []mcpgateway.JSONMap{{"user_id":"admin"},{"department_id":"x"},{"report":"employees","min_total_score":16},{"target":"summary","status":"approved"},{"target":"detail","skill_id":"x","report":"uploads"}}{if result:=call(ToolQuery,args);!result.IsError{t.Fatalf("未知或不适用条件未拒绝: %#v",args)}}
	if result:=call(ToolQuery,mcpgateway.JSONMap{"target":"summary"});result.IsError{t.Fatalf("授权概览失败: %#v",result)}
	result:=call(ToolExport,mcpgateway.JSONMap{"report":"first_approvals","min_total_score":16})
	if result.IsError{t.Fatalf("导出描述失败: %#v",result)}
	raw,_:=json.Marshal(result.StructuredContent)
	text:=string(raw)
	if !strings.Contains(text,`"type":"skill_contributions_csv"`) || strings.Contains(text,`"items"`) || strings.Contains(text,"https://") || strings.Contains(text,"token") {t.Fatalf("受控下载描述异常: %s",text)}
	if err=access.RemoveBy(ctx,"hr",dataaccess.ResourceDataView,dataaccess.ViewSkillContributions,"admin","request");err!=nil{t.Fatal(err)}
	if result:=call(ToolExport,mcpgateway.JSONMap{});!result.IsError{t.Fatal("撤销后工具仍可读取")}
}
