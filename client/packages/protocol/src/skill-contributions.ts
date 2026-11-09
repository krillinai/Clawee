export type SkillContributionQuery = {
  start_date?: string;
  end_date?: string;
  report?: 'uploads' | 'first_approvals' | 'employees';
  employee_id?: string;
  status?: 'pending' | 'approved' | 'rejected';
  min_total_score?: number;
  page?: number;
  page_size?: number;
};

export type SkillContributionScores = {
  scenario_value: number;
  result_effectiveness: number;
  ease_of_use: number;
  reuse_value: number;
  total: number;
};

export type SkillContributionRecord = {
  id: string;
  employee_id: string;
  employee_name: string;
  skill_id: string;
  skill_name: string;
  version_id: string;
  version: string | null;
  space_id: string;
  source: string;
  approval_id: string | null;
  occurred_at: string;
  status: string | null;
  scoring_standard_version: string | null;
  scores: SkillContributionScores | null;
  approvers: Array<{
    user_id: string;
    name: string;
    status: string;
    comment: string;
    decided_at?: string | null;
    scores?: Partial<Omit<SkillContributionScores, 'total'>> | null;
  }>;
  entity_available: boolean;
  history_status: string;
};

export type SkillContributionEmployee = {
  employee_id: string;
  employee_name: string;
  uploads: number;
  first_approvals: number;
  scored_count: number;
  average_score: number | null;
};

export type SkillContributionResponse = {
  query: SkillContributionQuery;
  timezone: string;
  generated_at: string;
  coverage: {
    first_approvals_from: string;
    uploads_from: string | null;
    notice: string;
  };
  summary?: {
    uploads: number;
    first_approvals: number;
    contributors: number;
    scored_count: number;
    average_score: number | null;
  };
  items?: Array<SkillContributionRecord | SkillContributionEmployee>;
  total: number;
};

export type SkillContributionDownload = {
  type: 'skill_contributions_csv';
  query: SkillContributionQuery;
};

export type SkillContributionCSV = {
  content: string;
  filename: string;
  rowCount: number;
};
