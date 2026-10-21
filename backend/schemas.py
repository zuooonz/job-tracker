from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

ReviewStatus = Literal["unreviewed", "viewed", "hold", "relevant", "recommended", "rejected"]
ApplicationStatus = Literal["not_started", "preparing", "applied", "contacted", "interview", "offer", "closed"]
SearchDirection = str


class LoginRequest(BaseModel):
    password: str


class SearchRunCreate(BaseModel):
    source: Literal["boss", "liepin"]
    keyword: str
    search_direction: SearchDirection
    filters: dict = Field(default_factory=dict)
    notes: str = ""


class SearchRunFinish(BaseModel):
    status: Literal["completed", "interrupted", "failed"] = "completed"
    notes: str | None = None


class DiscoveryInput(BaseModel):
    search_run_id: int | None = None
    keyword: str = ""
    search_direction: SearchDirection | None = None
    search_page_url: str = ""
    result_position: int | None = Field(default=None, ge=0)


class ScreeningRejectionInput(BaseModel):
    source: Literal["boss", "liepin"]
    url: str
    source_job_id: str | None = None
    title: str = ""
    company: str = ""
    location: str = ""
    salary: str = ""
    reasons: list[str] = Field(default_factory=list)
    rules_version: str = ""
    search_run_id: int | None = None
    keyword: str = ""
    search_direction: SearchDirection | None = None
    search_page_url: str = ""
    result_position: int | None = Field(default=None, ge=0)


class EvaluationInput(BaseModel):
    strategy_version: str = "resume-strategy-v1"
    evaluator: str = "codex"
    relevance_score: int | None = Field(default=None, ge=0, le=100)
    recommendation_level: Literal["priority", "normal", "opportunity", ""] = ""
    direction: str = ""
    summary: str = ""
    match_evidence: list[str] = Field(default_factory=list)
    gaps: list[str] = Field(default_factory=list)
    risk_notes: str = ""
    hard_requirements: list[dict] = Field(default_factory=list)
    filter_result: Literal["pass", "flag", "reject"] = "pass"
    filter_reasons: list[str] = Field(default_factory=list)
    filter_version: str = "resume-strategy-v1"
    resume_direction: str = ""
    needs_resume_tailoring: bool | None = None
    provider: str = ""
    model_name: str = ""
    prompt_version: str = ""
    profile_version: str = ""
    job_content_hash: str = ""
    input_hash: str = ""
    confidence_score: int | None = Field(default=None, ge=0, le=100)
    dimension_scores: dict = Field(default_factory=dict)
    raw_response: dict = Field(default_factory=dict)
    prompt_tokens: int | None = Field(default=None, ge=0)
    completion_tokens: int | None = Field(default=None, ge=0)
    total_tokens: int | None = Field(default=None, ge=0)
    latency_ms: int | None = Field(default=None, ge=0)


class EvaluationQueueCreate(BaseModel):
    mode: Literal["offpeak", "immediate"] = "offpeak"


class EvaluationQueueClaim(BaseModel):
    allow_offpeak: bool = False
    worker_id: str = "local-deepseek-worker"


class EvaluationQueueFinish(BaseModel):
    status: Literal["completed", "failed"]
    evaluation_id: int | None = None
    error: str = ""


class JobIngest(BaseModel):
    source: Literal["boss", "liepin"]
    url: str
    source_job_id: str | None = None
    title: str
    company: str = ""
    location: str = ""
    salary: str = ""
    update_time: str = ""
    relative_update_time: str = ""
    listing_status: str = ""
    experience: str = ""
    education: str = ""
    headcount: str = ""
    job_tags: list[str] | None = None
    benefits: list[str] | None = None
    recruiter_name: str = ""
    recruiter_title: str = ""
    recruiter_company: str = ""
    recruiter_tags: list[str] | None = None
    recruiter_activity: str = ""
    recruiter_verified: bool | None = None
    publisher_type: Literal["company_hr", "headhunter", "direct_manager", "unknown"] | None = None
    company_industry: str = ""
    company_size: str = ""
    company_stage: str = ""
    work_address: str = ""
    metadata: dict | None = None
    jd: str = ""
    review_status: ReviewStatus | None = None
    discovery: DiscoveryInput | None = None
    evaluation: EvaluationInput | None = None


class JobPatch(BaseModel):
    review_status: ReviewStatus | None = None
    user_score: int | None = Field(default=None, ge=0, le=100)
    user_notes: str | None = None
    listing_status: str | None = None

    chat_summary: str | None = None

class JobFeedback(BaseModel):
    user_score: int | None = Field(default=None, ge=0, le=100)
    user_notes: str = ""


class ApplicationPatch(BaseModel):
    status: ApplicationStatus | None = None
    notes: str | None = None


class ChatMessageInput(BaseModel):
    direction: Literal["out", "in", "system"]
    content: str = ""
    content_type: str = "text"
    sent_at: str = ""
    read_status: Literal["unread", "read", "unknown"] = "unknown"
    raw: dict = Field(default_factory=dict)


class ChatImportInput(BaseModel):
    source: str = ""
    active_monitoring: bool = False
    sync_kind: Literal["snapshot", "full_history"] = "snapshot"
    messages: list[ChatMessageInput] = Field(default_factory=list)


class ReplyDraftUpsert(BaseModel):
    job_id: int
    trigger_message_hash: str
    trigger_content: str = ""
    generation_status: Literal["queued", "completed", "failed"] = "completed"
    suggested_reply: str = ""
    edited_reply: str = ""
    rationale: str = ""
    risk_flags: list[str] = Field(default_factory=list)
    model_name: str = ""
    prompt_version: str = ""
    error: str = ""


class ReplyDraftPatch(BaseModel):
    status: Literal["pending", "sent", "dismissed"] | None = None
    edited_reply: str | None = None


class AutomationStatusUpdate(BaseModel):
    status: Literal["online", "sleeping", "login_required", "login_pending", "offline", "error"]
    message: str = ""
    last_success_at: str | None = None
    next_run_at: str | None = None
    metadata: dict = Field(default_factory=dict)


class ApplyRecordInput(BaseModel):
    url: str = ""
    title: str = ""
    feedback: str = ""
    feedback_at: str = ""


class ApplyRecordsInput(BaseModel):
    records: list[ApplyRecordInput] = Field(default_factory=list)
