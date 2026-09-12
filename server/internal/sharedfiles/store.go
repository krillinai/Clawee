package sharedfiles

import "context"

type Store interface {
	CreateSpace(context.Context, Space) (SpaceSummary, error)
	UpdateSpace(context.Context, Space) (SpaceSummary, error)
	GetSpaceSummary(context.Context, string) (SpaceSummary, error)
	ListSpaceSummaries(context.Context, SpaceFilter) ([]SpaceSummary, error)
	ListAuthorizedSpaces(context.Context, SpaceFilter) ([]Space, error)
	ListMembers(context.Context, MemberFilter) ([]Member, error)
	ListMemberCandidates(context.Context, MemberFilter) ([]MemberCandidate, error)
	AddMember(context.Context, string, string, []string, string) (Member, error)
	UpdateMember(context.Context, string, string, []string, string) (Member, error)
	RemoveMember(context.Context, string, string) error
	ListFiles(context.Context, FileFilter) ([]File, error)
	ListAdminFiles(context.Context, FileFilter) ([]File, error)
	CheckSpaceAccess(context.Context, string, string, string) error
	GetAuthorizedFile(context.Context, string, string, string) (File, error)
	GetAuthorizedFileByPath(context.Context, string, string, string, string) (File, error)
	GetAdminFile(context.Context, string) (File, error)
	GetAdminFileByPath(context.Context, string, string) (File, error)
	CreateFileAuthorized(context.Context, string, File) (File, error)
	ReplaceFileAuthorized(context.Context, string, File, int64) (File, ObjectRef, error)
	CreateAdminFile(context.Context, File) (File, error)
	ReplaceAdminFile(context.Context, File, int64) (File, ObjectRef, error)
}
