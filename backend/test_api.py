from __future__ import annotations

import importlib
import sys
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient


class JobTrackerApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_dir = tempfile.TemporaryDirectory()
        backend_dir = Path(__file__).resolve().parent
        sys.path.insert(0, str(backend_dir))
        import db

        db.DB_PATH = Path(cls.temp_dir.name) / "jobs.sqlite3"
        cls.db = db
        import main

        cls.main = importlib.reload(main)
        cls.test_config_dir = Path(cls.temp_dir.name) / "config"
        cls.test_config_dir.mkdir(parents=True, exist_ok=True)
        public_config = Path(cls.main.common.PROJECT_ROOT) / "automation" / "config"
        for filename in ("search-plan-v2.json", "search-strategy.json", "candidate-profile-v2.json", "evaluation-strategy-v2.json", "automation-policy.json", "reply-draft-prompt.md"):
            (cls.test_config_dir / filename).write_text((public_config / filename).read_text(encoding="utf-8"), encoding="utf-8")
        profile_path = cls.test_config_dir / "candidate-profile-v2.json"
        profile = __import__("json").loads(profile_path.read_text(encoding="utf-8"))
        profile["version"] = "candidate-profile-test"
        profile["positioning"] = "test profile"
        profile_path.write_text(__import__("json").dumps(profile), encoding="utf-8")
        cls.main.common.CONFIG_DIR = cls.test_config_dir
        cls.main.common._directions_cache = None
        cls.client_context = TestClient(cls.main.app)
        cls.client = cls.client_context.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.client_context.__exit__(None, None, None)
        cls.temp_dir.cleanup()

    def test_root_and_one_route_per_router(self):
        self.assertEqual(self.client.get("/").status_code, 200)
        self.assertEqual(self.client.get("/api/search-plan").status_code, 200)
        self.assertEqual(self.client.get("/api/automation/status").status_code, 200)
        self.assertEqual(self.client.get("/api/evaluation-schedule").status_code, 200)
        self.assertEqual(self.client.get("/api/chat-sync/targets").status_code, 200)
        self.assertEqual(self.client.get("/api/stats").status_code, 200)

    def test_full_job_lifecycle(self):
        run = self.client.post("/api/search-runs", json={
            "source": "liepin",
            "keyword": "数据产品项目经理",
            "search_direction": "product_role",
            "filters": {"city": "示例地点"},
        })
        self.assertEqual(run.status_code, 200)
        run_id = run.json()["id"]

        payload = {
            "source": "liepin",
            "url": "https://www.liepin.com/job/123456.shtml?tracking=first",
            "title": "数据产品项目经理",
            "company": "测试科技公司",
            "location": "示例地点",
            "salary": "25-35k",
            "update_time": "2026-08-12",
            "relative_update_time": "3天前更新",
            "listing_status": "招聘中",
            "experience": "3年以上",
            "education": "硕士",
            "headcount": "招1人",
            "job_tags": ["数据产品", "项目交付"],
            "benefits": ["五险一金", "带薪年假"],
            "recruiter_name": "招聘者",
            "recruiter_title": "HR",
            "recruiter_company": "测试科技公司",
            "recruiter_tags": ["回复快"],
            "recruiter_activity": "2天前在线",
            "recruiter_verified": True,
            "publisher_type": "company_hr",
            "company_industry": "人工智能",
            "company_size": "50-99人",
            "company_stage": "A轮",
            "work_address": "示例地址 1 号",
            "metadata": {"department": "数据合规部", "language": "普通话"},
            "jd": "负责数据治理、跨部门项目交付与质量控制。",
            "review_status": "recommended",
            "discovery": {
                "search_run_id": run_id,
                "keyword": "数据产品项目经理",
                "search_page_url": "https://www.liepin.com/zhaopin/?key=test",
                "result_position": 1,
            },
            "evaluation": {
                "strategy_version": "test-v1",
                "relevance_score": 88,
                "recommendation_level": "priority",
                "direction": "product_role",
                "summary": "数据治理与项目交付岗位",
                "match_evidence": ["数据治理", "服务商 项目管理"],
                "gaps": ["团队规模待确认"],
                "hard_requirements": [{"item": "专业背景", "result": "matched"}],
                "resume_direction": "数据产品项目交付",
                "needs_resume_tailoring": True,
            },
        }
        created = self.client.post("/api/jobs", json=payload)
        self.assertEqual(created.status_code, 200, created.text)
        first = created.json()
        self.assertTrue(first["is_new"])
        self.assertEqual(first["source_job_id"], "job:123456")
        self.assertEqual(first["canonical_url"], "https://www.liepin.com/job/123456.shtml")
        self.assertEqual(first["relevance_score"], 88)
        self.assertEqual(first["evaluation_direction"], "product_role")
        self.assertEqual(first["search_directions"], ["product_role"])
        self.assertEqual(first["experience"], "3年以上")
        self.assertEqual(first["job_tags"], ["数据产品", "项目交付"])
        self.assertEqual(first["benefits"], ["五险一金", "带薪年假"])
        self.assertEqual(first["publisher_type"], "company_hr")
        self.assertEqual(first["recruiter_company"], "测试科技公司")
        self.assertEqual(first["recruiter_tags"], ["回复快"])
        self.assertTrue(first["recruiter_verified"])
        self.assertEqual(first["metadata"]["department"], "数据合规部")
        job_id = first["id"]

        payload["url"] = "https://www.liepin.com/job/123456.shtml?tracking=second"
        payload["evaluation"] = None
        repeated = self.client.post("/api/jobs", json=payload)
        self.assertEqual(repeated.status_code, 200, repeated.text)
        self.assertFalse(repeated.json()["is_new"])
        self.assertEqual(repeated.json()["discovery_count"], 1)
        self.assertEqual(repeated.json()["snapshot_count"], 1)
        self.assertEqual(repeated.json()["recruiter_name"], "招聘者")

        second_run = self.client.post("/api/search-runs", json={
            "source": "liepin",
            "keyword": "AI应用产品经理",
            "search_direction": "technology_role",
        }).json()
        payload["discovery"] = {
            "search_run_id": second_run["id"],
            "keyword": "AI应用产品经理",
            "search_page_url": "https://www.liepin.com/zhaopin/?key=product-search",
            "result_position": 2,
        }
        multi_hit = self.client.post("/api/jobs", json=payload)
        self.assertEqual(multi_hit.status_code, 200, multi_hit.text)
        self.assertEqual(multi_hit.json()["discovery_count"], 2)
        self.assertEqual(set(multi_hit.json()["search_directions"]), {"product_role", "technology_role"})
        self.assertEqual(len(self.client.get("/api/jobs", params={"search_direction": "technology_role"}).json()), 1)
        self.assertEqual(len(self.client.get("/api/jobs", params={"evaluation_direction": "product_role"}).json()), 1)

        evaluation = self.client.post(f"/api/jobs/{job_id}/evaluations", json={
            "strategy_version": "test-v2",
            "evaluator": "deepseek-api",
            "relevance_score": 91,
            "recommendation_level": "priority",
            "direction": "product_role",
            "summary": "复核后仍为优先岗位",
            "match_evidence": ["数据治理", "项目交付"],
            "provider": "deepseek",
            "model_name": "deepseek-v4-flash",
            "prompt_version": "evaluation-prompt-v2",
            "profile_version": "candidate-profile-v2",
            "job_content_hash": "job-hash-v2",
            "input_hash": "input-hash-v2",
            "confidence_score": 84,
            "dimension_scores": {"domain_task_alignment": 24, "hard_requirements": 18},
            "raw_response": {"score": 91},
            "prompt_tokens": 1200,
            "completion_tokens": 600,
            "total_tokens": 1800,
            "latency_ms": 3200,
        })
        self.assertEqual(evaluation.status_code, 200, evaluation.text)
        self.assertEqual(evaluation.json()["model_name"], "deepseek-v4-flash")
        self.assertEqual(evaluation.json()["confidence_score"], 84)
        self.assertEqual(evaluation.json()["dimension_scores"]["domain_task_alignment"], 24)

        rated = self.client.patch(f"/api/jobs/{job_id}", json={"user_score": 80})
        self.assertEqual(rated.status_code, 200, rated.text)
        self.assertEqual(rated.json()["user_score"], 80)
        self.assertEqual(len(self.client.get("/api/jobs", params={"evaluation_status": "evaluated"}).json()), 1)
        self.assertEqual(len(self.client.get("/api/jobs", params={"evaluation_status": "unevaluated"}).json()), 0)
        self.assertEqual(len(self.client.get("/api/jobs", params={"rating_status": "rated"}).json()), 1)
        self.assertEqual(len(self.client.get("/api/jobs", params={"rating_status": "unrated"}).json()), 0)

        queued = self.client.post(f"/api/jobs/{job_id}/evaluation-queue", json={"mode": "offpeak"})
        self.assertEqual(queued.status_code, 200, queued.text)
        self.assertEqual(queued.json()["status"], "queued")
        self.assertIsNone(self.client.post("/api/evaluation-queue/claim", json={"allow_offpeak": False}).json())
        urgent = self.client.post(f"/api/jobs/{job_id}/evaluation-queue", json={"mode": "immediate"})
        self.assertEqual(urgent.json()["mode"], "immediate")
        claimed = self.client.post("/api/evaluation-queue/claim", json={"allow_offpeak": False})
        self.assertEqual(claimed.status_code, 200, claimed.text)
        self.assertEqual(claimed.json()["status"], "running")
        finished_queue = self.client.patch(f"/api/evaluation-queue/{claimed.json()['id']}", json={
            "status": "completed", "evaluation_id": evaluation.json()["id"]
        })
        self.assertEqual(finished_queue.status_code, 200, finished_queue.text)
        self.assertEqual(finished_queue.json()["status"], "completed")

        application = self.client.patch(f"/api/jobs/{job_id}/application", json={
            "status": "applied",
        })
        self.assertEqual(application.status_code, 200, application.text)
        self.assertEqual(application.json()["application_status"], "applied")
        self.assertEqual(self.client.get("/api/jobs", params={"funnel_status": "contacted"}).json()[0]["funnel_status"], "contacted")
        self.assertEqual(self.client.get("/api/jobs", params={"funnel_status": "offer"}).json(), [])

        detail = self.client.get(f"/api/jobs/{job_id}")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(len(detail.json()["evaluations"]), 2)
        self.assertGreaterEqual(len(detail.json()["events"]), 5)

        search = self.client.get("/api/jobs", params={"q": "数据产品"})
        self.assertEqual(search.status_code, 200, search.text)
        self.assertEqual(len(search.json()), 1)

        finished = self.client.patch(f"/api/search-runs/{run_id}", json={"status": "completed"})
        self.assertEqual(finished.status_code, 200, finished.text)
        self.assertEqual(finished.json()["result_count"], 1)
        self.assertEqual(finished.json()["new_job_count"], 1)
        self.assertEqual(finished.json()["recommended_count"], 1)

        stats = self.client.get("/api/stats").json()
        self.assertEqual(stats["total"], 1)
        self.assertEqual(stats["review_statuses"]["recommended"], 1)
        self.assertEqual(stats["application_statuses"]["applied"], 1)
        # 交集计数：application=applied 时，处理状态只统计已投递的子集
        stats2 = self.client.get("/api/stats", params={"application_status": "applied"}).json()
        self.assertEqual(stats2["total"], 1)
        self.assertEqual(stats2["review_statuses"]["recommended"], 1)
        stats3 = self.client.get("/api/stats", params={"review_status": "viewed"}).json()
        self.assertEqual(stats3["total"], 0)
        self.assertEqual(stats3["application_statuses"]["applied"], 0)

    def test_automation_budget_and_cooldown(self):
        policy = {"daily_caps": {"boss": {"detail_opens": 1, "chat_opens": 2}, "liepin": {"detail_opens": 2, "chat_opens": 2}}, "cooldown_minutes": 60}
        saved = self.client.put("/api/settings/automation-policy", json=policy)
        self.assertEqual(saved.status_code, 200, saved.text)
        reserve = {"action": "reserve", "platform": "boss", "kind": "detail_opens"}
        self.assertEqual(self.client.post("/api/automation/budget", json=reserve).status_code, 200)
        self.assertEqual(self.client.post("/api/automation/budget", json=reserve).status_code, 409)
        self.client.post("/api/automation/budget", json={"action": "intercept", "platform": "boss"})
        self.assertEqual(self.client.post("/api/automation/budget", json={"action": "reserve", "platform": "boss", "kind": "chat_opens"}).status_code, 409)
        self.assertEqual(self.client.post("/api/automation/budget", json={"action": "reset_cooldown", "platform": "boss"}).status_code, 200)

    def test_public_example_profile_disables_evaluation(self):
        path = self.test_config_dir / "candidate-profile-v2.json"
        profile = __import__("json").loads(path.read_text(encoding="utf-8"))
        profile["version"] = "candidate-profile-v2-example"
        path.write_text(__import__("json").dumps(profile), encoding="utf-8")
        try:
            response = self.client.post("/api/jobs/1/evaluation-queue", json={"mode": "offpeak"})
            self.assertEqual(response.status_code, 409)
            self.assertIn("公开示例", response.json()["detail"])
        finally:
            profile["version"] = "candidate-profile-test"
            path.write_text(__import__("json").dumps(profile), encoding="utf-8")

    def test_peak_pricing_windows(self):
        tz = ZoneInfo("Asia/Shanghai")
        self.assertTrue(self.main.common.evaluation_schedule(datetime(2026, 8, 15, 10, 0, tzinfo=tz))["is_peak"])
        self.assertTrue(self.main.common.evaluation_schedule(datetime(2026, 8, 15, 15, 0, tzinfo=tz))["is_peak"])
        self.assertTrue(self.main.common.evaluation_schedule(datetime(2026, 8, 15, 12, 0, tzinfo=tz))["is_offpeak"])
        self.assertTrue(self.main.common.evaluation_schedule(datetime(2026, 8, 15, 18, 0, tzinfo=tz))["is_offpeak"])

    def test_screening_rejection_is_lightweight_and_never_queued(self):
        rejected = self.client.post("/api/screening-rejections", json={
            "source": "boss",
            "url": "https://www.zhipin.com/job_detail/rejected-meal.html?track=1",
            "title": "团餐项目经理",
            "company": "示例餐饮",
            "salary": "11-18K",
            "reasons": ["标题命中无关领域词：团餐", "月薪上限 18K 低于 20K"],
            "rules_version": "resume-search-gate-v2",
        })
        self.assertEqual(rejected.status_code, 200, rejected.text)
        self.assertEqual(rejected.json()["canonical_url"], "https://www.zhipin.com/job_detail/rejected-meal.html")
        self.assertEqual(rejected.json()["seen_count"], 1)

        repeated = self.client.post("/api/screening-rejections", json={
            "source": "boss",
            "url": "https://www.zhipin.com/job_detail/rejected-meal.html?track=2",
            "title": "团餐项目经理",
            "reasons": ["此前已通过本地硬门槛排除"],
        })
        self.assertEqual(repeated.json()["seen_count"], 2)
        listed = self.client.get("/api/screening-rejections", params={"source": "boss"})
        self.assertEqual(len(listed.json()), 1)

        payload = {
            "source": "boss",
            "url": "https://www.zhipin.com/job_detail/defence-in-depth.html",
            "title": "无关岗位",
            "company": "示例公司",
            "salary": "30-40K",
            "jd": "这是一段字段完整但已被本地硬门槛明确排除的岗位描述。",
            "metadata": {
                "extraction_quality": {"status": "pass"},
                "screening": {"status": "reject", "reasons": ["无关领域"]},
            },
        }
        created = self.client.post("/api/jobs", json=payload)
        self.assertEqual(created.status_code, 200, created.text)
        job_id = created.json()["id"]
        with self.db.connect() as conn:
            queued = conn.execute(
                "SELECT COUNT(*) FROM evaluation_queue WHERE job_id=?", (job_id,)
            ).fetchone()[0]
        self.assertEqual(queued, 0)

    def test_lan_frontend_origin_is_allowed(self):
        response = self.client.options("/api/jobs", headers={
            "Origin": "http://192.168.1.100:5175",
            "Access-Control-Request-Method": "GET",
        })
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers.get("access-control-allow-origin"), "http://192.168.1.100:5175")

    def test_pagination_beyond_one_thousand_jobs(self):
        stamp = "2026-08-15T12:00:00+08:00"
        rows = []
        for index in range(1205):
            url = f"https://www.zhipin.com/job_detail/capacity-{index}.html"
            rows.append((
                "boss", f"capacity-{index}", url, url, f"容量测试岗位 {index}",
                "测试公司", "示例地点", "20-30k", "", "长期容量与分页测试", f"hash-{index}",
                "unreviewed", stamp, stamp, stamp, stamp,
            ))
        with self.db.connect() as conn:
            before = conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
            conn.executemany(
                """INSERT INTO jobs(
                    source, source_job_id, canonical_url, url, title, company, location, salary,
                    update_time, jd, content_hash, review_status,
                    first_seen_at, last_seen_at, last_checked_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                rows,
            )

        first_page = self.client.get("/api/jobs", params={"limit": 1000, "offset": 0})
        self.assertEqual(first_page.status_code, 200, first_page.text)
        self.assertEqual(len(first_page.json()), 1000)
        self.assertEqual(int(first_page.headers["X-Total-Count"]), before + 1205)

        second_page = self.client.get("/api/jobs", params={"limit": 1000, "offset": 1000})
        self.assertEqual(second_page.status_code, 200, second_page.text)
        self.assertEqual(len(second_page.json()), before + 205)


    def test_state_filter_and_counts(self):
        """岗位状态（派生组合视图）：未处理/已投递沟通/面试中/已排除 的过滤与交集计数。"""
        def list_total(state):
            response = self.client.get("/api/jobs", params={"state": state})
            return int(response.headers["X-Total-Count"])

        base = self.client.get("/api/stats").json()["state_statuses"]
        base_total = self.client.get("/api/stats").json()["state_total"]
        funnel_base = self.client.get("/api/stats").json()["funnel_statuses"]

        job_ids = []
        for i in range(5):
            self.client.post("/api/search-runs", json={
                "source": "boss", "keyword": f"state-{i}", "search_direction": "product_role",
            })
            created = self.client.post("/api/jobs", json={
                "source": "boss", "url": f"https://www.zhipin.com/job_detail/state-{i}.html",
                "title": f"状态测试岗位{i}", "company": "测试", "jd": "负责数据治理。",
            })
            job_ids.append(created.json()["id"])
        self.client.patch(f"/api/jobs/{job_ids[0]}/application", json={"status": "applied"})
        self.client.patch(f"/api/jobs/{job_ids[1]}/application", json={"status": "contacted"})
        self.client.patch(f"/api/jobs/{job_ids[2]}/application", json={"status": "interview"})
        self.client.patch(f"/api/jobs/{job_ids[3]}", json={"review_status": "rejected"})

        self.assertEqual(list_total("not_started") - base["not_started"], 1)          # 仅 job_ids[4]
        self.assertEqual(list_total("applied_contacted") - base["applied_contacted"], 2)
        self.assertEqual(list_total("interview") - base["interview"], 1)
        self.assertEqual(list_total("rejected") - base["rejected"], 1)
        self.assertEqual(list_total("all") - base_total, 5)

        stats = self.client.get("/api/stats").json()
        self.assertEqual(stats["state_statuses"]["not_started"] - base["not_started"], 1)
        self.assertEqual(stats["state_statuses"]["applied_contacted"] - base["applied_contacted"], 2)
        self.assertEqual(stats["state_statuses"]["interview"] - base["interview"], 1)
        self.assertEqual(stats["state_statuses"]["rejected"] - base["rejected"], 1)

        self.assertEqual(stats["funnel_statuses"]["todo"] - funnel_base["todo"], 1)
        self.assertEqual(stats["funnel_statuses"]["contacted"] - funnel_base["contacted"], 2)
        self.assertEqual(stats["funnel_statuses"]["interview"] - funnel_base["interview"], 1)
        self.assertEqual(stats["funnel_statuses"]["excluded"] - funnel_base["excluded"], 1)
        # Each funnel count is produced by the same filter used by /api/jobs.
        for status in ("todo", "interested", "contacted", "interview", "offer", "closed", "excluded"):
            filtered = self.client.get("/api/jobs", params={"funnel_status": status})
            self.assertEqual(int(filtered.headers["X-Total-Count"]), self.client.get("/api/stats").json()["funnel_statuses"][status])
        scoped = self.client.get("/api/stats", params={"source": "boss", "q": "状态测试岗位"}).json()["funnel_statuses"]
        self.assertEqual(sum(scoped.values()), 5)

        # 多选：逗号分隔取并集（应用了 applied/contacted 的两个岗位）
        self.assertEqual(list_total("applied_contacted,interview") - (base["applied_contacted"] + base["interview"]), 3)
        # 多选 + 单选互不干扰：空串等价于 all
        self.assertEqual(list_total("") - base_total, 5)
        self.assertEqual(list_total("all") - base_total, 5)
        # stats 在多选下：去 state 维度后各状态计数不变
        stats_multi = self.client.get("/api/stats", params={"state": "not_started,rejected"}).json()
        self.assertEqual(stats_multi["state_statuses"]["interview"] - base["interview"], 1)


    def test_chat_state_derivation(self):
        """沟通状态推导回归：对方回复过（存在 in 消息）→ replied，不被我方后续未读降级。"""
        cs = self.main.common.chat_state
        sm = self.main.common.chat_summary
        base = {"chat_message_count": 4, "chat_outbound_sent_at": "2026-08-17T01:47:00.000Z",
                "chat_last_inbound_at": "2026-08-17T01:47:00.000Z", "chat_outbound_read_status": "unread"}
        # 对方回复过 + 我方后续致谢未读 → 仍为 replied（原 bug：误判 unread）
        self.assertEqual(cs(base), "replied")
        self.assertIn("待进一步反馈", sm(base))
        # 对方从未回复、我最后消息已读 → read_no_reply
        rnr = dict(base); rnr["chat_last_inbound_at"] = ""; rnr["chat_outbound_read_status"] = "read"
        self.assertEqual(cs(rnr), "read_no_reply")
        # 对方从未回复、我最后消息未读 → unread
        un = dict(base); un["chat_last_inbound_at"] = ""; un["chat_outbound_read_status"] = "unread"
        self.assertEqual(cs(un), "unread")
        # 无消息 → none
        self.assertEqual(cs({"chat_message_count": 0}), "none")

    def test_z_chat_append_distinguishes_snapshot_and_full_history(self):
        created = self.client.post("/api/jobs", json={
            "source": "boss",
            "url": "https://www.zhipin.com/job_detail/chat-append-mode.html",
            "title": "产品经理",
            "company": "沟通增量测试公司",
            "jd": "负责行业产品设计与项目交付。",
        })
        job_id = created.json()["id"]
        message = {"direction": "in", "content": "方便沟通吗？", "sent_at": "2026-08-31T10:00:00+08:00"}

        first = self.client.post(f"/api/jobs/{job_id}/chat-append", json={
            "source": "boss", "sync_kind": "snapshot", "messages": [message],
        })
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["imported"], 1)
        repeated = self.client.post(f"/api/jobs/{job_id}/chat-append", json={
            "source": "boss", "sync_kind": "snapshot", "messages": [message],
        })
        self.assertEqual(repeated.json()["imported"], 0)
        full = self.client.post(f"/api/jobs/{job_id}/chat-append", json={
            "source": "boss", "sync_kind": "full_history", "messages": [message],
        })
        self.assertEqual(full.json()["imported"], 0)

        events = self.client.get(f"/api/jobs/{job_id}").json()["events"]
        event_types = [item["event_type"] for item in events]
        self.assertEqual(event_types.count("chat_snapshot_appended"), 1)
        self.assertEqual(event_types.count("chat_full_history_synced"), 1)

    def test_reply_draft_is_generated_only_on_explicit_request(self):
        created = self.client.post("/api/jobs", json={
            "source": "boss",
            "url": "https://www.zhipin.com/job_detail/reply-draft-test.html",
            "title": "数据产品项目经理",
            "company": "草稿测试公司",
            "jd": "负责数据治理和项目交付。",
        })
        self.assertEqual(created.status_code, 200, created.text)
        job_id = created.json()["id"]
        baseline = [{
            "direction": "out", "content": "您好，希望进一步沟通", "sent_at": "2026-08-22T09:00:00+08:00",
        }]
        first = self.client.post(f"/api/jobs/{job_id}/chat", json={"source": "boss", "messages": baseline})
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["new_inbound"], [])

        changed = [*baseline, {
            "direction": "in", "content": "方便介绍一下产品项目吗？", "sent_at": "2026-08-22T09:05:00+08:00",
        }, {
            "direction": "in", "content": "你主要负责哪一部分？", "sent_at": "2026-08-22T09:06:00+08:00",
        }]
        second = self.client.post(f"/api/jobs/{job_id}/chat", json={"source": "boss", "messages": changed})
        self.assertEqual(len(second.json()["new_inbound"]), 2)
        queued = [item for item in self.client.get("/api/communication/inbox").json() if item["job_id"] == job_id]
        self.assertEqual(queued, [])

        model_result = ({
            "should_reply": True,
            "reply": "您好，我做过数据治理项目。",
            "rationale": "直接回答招聘者问题",
            "risk_flags": ["发送前确认项目细节"],
        }, "test-model")
        with patch.object(self.main.common, "call_reply_model", return_value=model_result):
            generated = self.client.post(f"/api/jobs/{job_id}/reply-draft/generate")
        self.assertEqual(generated.status_code, 200, generated.text)
        draft_id = generated.json()["id"]
        self.assertEqual(generated.json()["trigger_content"], "你主要负责哪一部分？")
        self.assertEqual(generated.json()["generation_status"], "completed")
        self.assertEqual(self.client.get(f"/api/jobs/{job_id}/chat").json()["reply_draft"]["id"], draft_id)
        edited = self.client.patch(f"/api/reply-drafts/{draft_id}", json={"edited_reply": "您好，我可以具体介绍两个项目。"})
        self.assertEqual(edited.json()["edited_reply"], "您好，我可以具体介绍两个项目。")
        sent = self.client.patch(f"/api/reply-drafts/{draft_id}", json={"status": "sent"})
        self.assertEqual(sent.json()["status"], "sent")
        pending_ids = {item["id"] for item in self.client.get("/api/communication/inbox").json()}
        self.assertNotIn(draft_id, pending_ids)

    def test_z_active_first_chat_does_not_create_reply_draft(self):
        created = self.client.post("/api/jobs", json={
            "source": "boss",
            "url": "https://www.zhipin.com/job_detail/active-first-chat.html",
            "title": "新会话岗位",
            "company": "监测测试公司",
            "jd": "负责数据产品项目。",
        })
        job_id = created.json()["id"]
        messages = [
            {"direction": "out", "content": "您好", "sent_at": "2026-08-22T10:00:00+08:00"},
            {"direction": "in", "content": "可以介绍项目吗？", "sent_at": "2026-08-22T10:01:00+08:00"},
            {"direction": "in", "content": "您方便什么时候沟通？", "sent_at": "2026-08-22T10:02:00+08:00"},
        ]
        imported = self.client.post(
            f"/api/jobs/{job_id}/chat",
            json={"source": "boss", "active_monitoring": True, "messages": messages},
        )
        self.assertEqual(imported.status_code, 200, imported.text)
        self.assertEqual(imported.json()["new_inbound"], [])
        drafts = [item for item in self.client.get("/api/communication/inbox").json() if item["job_id"] == job_id]
        self.assertEqual(drafts, [])

    def test_automation_status_without_qr_relay(self):
        updated = self.client.post("/api/automation/boss/status", json={
            "status": "login_pending",
            "message": "等待扫码",
            "next_run_at": "2026-08-22T21:00:00+08:00",
            "metadata": {"monitor_window": "09:00-21:00"},
        })
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["metadata"]["monitor_window"], "09:00-21:00")
        self.assertNotIn("qr_available", updated.json())
        self.assertEqual(self.client.get("/api/automation/boss/qr").status_code, 404)

    def test_source_filter(self):
        """来源过滤器：boss / liepin 列表过滤与统计计数。"""
        def list_total(source):
            response = self.client.get("/api/jobs", params={"source": source})
            return int(response.headers["X-Total-Count"])

        boss_before = list_total("boss")
        liepin_before = list_total("liepin")
        all_before = list_total("all")
        for i in range(3):
            self.client.post("/api/search-runs", json={
                "source": "boss", "keyword": f"src-{i}", "search_direction": "product_role",
            })
            self.client.post("/api/jobs", json={
                "source": "boss", "url": f"https://www.zhipin.com/job_detail/src-{i}.html",
                "title": f"来源测试岗位{i}", "company": "测试", "jd": "负责数据治理。",
            })
        self.client.post("/api/jobs", json={
            "source": "liepin", "url": "https://www.liepin.com/job/src-liepin.html",
            "title": "猎聘来源岗位", "company": "测试", "jd": "负责数据治理。",
        })

        self.assertEqual(list_total("boss") - boss_before, 3)
        self.assertEqual(list_total("liepin") - liepin_before, 1)
        self.assertEqual(list_total("all") - all_before, 4)
        # stats 带 source：总数反映来源过滤
        stats_boss = self.client.get("/api/stats", params={"source": "boss"}).json()
        self.assertEqual(stats_boss["total"], boss_before + 3)

    def test_search_plan_get_uses_example_when_private_missing(self):
        # 用临时目录，避免本机已有私有配置时测试结果不同
        with tempfile.TemporaryDirectory() as temp:
            config = Path(temp)
            (config / "search-plan-v2.json").write_text(
                (Path(self.main.common.PROJECT_ROOT) / "automation" / "config" / "search-plan-v2.json").read_text(encoding="utf-8"),
                encoding="utf-8")
            with patch.object(self.main.common, "CONFIG_DIR", config):
                response = self.client.get("/api/search-plan")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["path_kind"], "example")
        self.assertTrue(response.json()["plan"]["directions"])

    def test_search_plan_put_writes_private_and_keeps_other_fields(self):
        temp_config = Path(self.temp_dir.name) / "config"
        source = Path(self.main.common.PROJECT_ROOT) / "automation" / "config" / "search-plan-v2.json"
        private = temp_config / "private" / "search-plan-v2.json"
        private.parent.mkdir(parents=True, exist_ok=True)
        private.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")
        before = __import__("json").loads(private.read_text(encoding="utf-8"))
        direction = {"id": "test_direction", "priority": "A", "label": "测试方向", "boss": {"seed": [" 测试词 ", "测试词"], "variants": ["扩展词"]}, "liepin": {"seed": ["测试词"], "variants": []}}
        with patch.object(self.main.common, "CONFIG_DIR", temp_config):
            response = self.client.put("/api/search-plan", json={"directions": [direction], "disabled_queries": [{"platform": "boss", "keyword": "噪音词", "reason": "原因"}]})
            result = response.json()
            saved = __import__("json").loads(private.read_text(encoding="utf-8"))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(result["path_kind"], "private")
        self.assertEqual(saved["directions"][0]["boss"]["seed"], ["测试词"])
        self.assertEqual(saved["disabled_queries"][0]["keyword"], "噪音词")
        self.assertEqual(saved["execution_policy"], before["execution_policy"])
        self.assertTrue(saved["updated_at"])
        backups = list((private.parent / "backups").glob("*.json"))
        self.assertEqual(len(backups), 1)

    def test_search_plan_put_rejects_invalid_direction(self):
        valid = {"id": "valid_one", "priority": "B", "label": "方向", "boss": {"seed": ["共享词"], "variants": []}, "liepin": {"seed": [], "variants": []}}
        with patch.object(self.main.common, "CONFIG_DIR", self.test_config_dir):
            invalid_id = self.client.put("/api/search-plan", json={"directions": [{**valid, "id": "Bad"}], "disabled_queries": []})
            invalid_priority = self.client.put("/api/search-plan", json={"directions": [{**valid, "priority": "D"}], "disabled_queries": []})
        self.assertEqual(invalid_id.status_code, 422)
        self.assertIn("ID", invalid_id.json()["detail"])
        self.assertEqual(invalid_priority.status_code, 422)

    def test_search_plan_put_allows_shared_keyword_with_warning(self):
        valid = {"id": "valid_one", "priority": "B", "label": "方向", "boss": {"seed": ["共享词"], "variants": []}, "liepin": {"seed": [], "variants": []}}
        duplicate = {"id": "valid_two", "priority": "C", "label": "方向二", "boss": {"seed": [], "variants": ["共享词"]}, "liepin": {"seed": [], "variants": []}}
        with tempfile.TemporaryDirectory() as temp:
            config = Path(temp)
            (config / "search-plan-v2.json").write_text(
                (Path(self.main.common.PROJECT_ROOT) / "automation" / "config" / "search-plan-v2.json").read_text(encoding="utf-8"),
                encoding="utf-8")
            with patch.object(self.main.common, "CONFIG_DIR", config):
                response = self.client.put("/api/search-plan", json={"directions": [valid, duplicate], "disabled_queries": []})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertTrue(any("共享词" in item for item in response.json()["warnings"]))
            self.assertTrue((config / "private" / "search-plan-v2.json").exists())

    def test_settings_endpoints_round_trip_private_configs(self):
        import json
        with tempfile.TemporaryDirectory() as temp:
            config = Path(temp)
            public = Path(self.main.common.PROJECT_ROOT) / "automation" / "config"
            for filename in ("search-strategy.json", "candidate-profile-v2.json", "evaluation-strategy-v2.json", "search-plan-v2.json"):
                (config / filename).write_text((public / filename).read_text(encoding="utf-8"), encoding="utf-8")
            private = config / "private"
            private.mkdir()
            for filename in ("search-strategy.json", "candidate-profile-v2.json", "evaluation-strategy-v2.json"):
                (private / filename).write_text((config / filename).read_text(encoding="utf-8"), encoding="utf-8")
            with patch.object(self.main.common, "CONFIG_DIR", config):
                strategy = self.client.get("/api/settings/search-strategy")
                strategy_value = strategy.json()["value"]
                strategy_value["minimumMonthlySalaryMaxK"] = 18
                self.assertEqual(self.client.put("/api/settings/search-strategy", json=strategy_value).status_code, 200)
                profile = self.client.get("/api/settings/candidate-profile").json()["value"]
                profile["positioning"] = "测试定位"
                self.assertEqual(self.client.put("/api/settings/candidate-profile", json=profile).status_code, 200)
                evaluation = self.client.get("/api/settings/evaluation-strategy").json()["value"]
                evaluation["api"].update({"model": "example-model", "thinking": "disabled", "max_tokens": 2048})
                self.assertEqual(self.client.put("/api/settings/evaluation-strategy", json=evaluation).status_code, 200)
                invalid = json.loads(json.dumps(evaluation))
                invalid["dimensions"][next(iter(invalid["dimensions"]))]["weight"] = 99
                self.assertEqual(self.client.put("/api/settings/evaluation-strategy", json=invalid).status_code, 422)
                environment = self.client.get("/api/settings/environment").json()
            self.assertEqual(json.loads((config / "private" / "evaluation-strategy-v2.json").read_text())["api"]["model"], "example-model")
            self.assertEqual(len(list((config / "private" / "backups").glob("*.json"))), 3)
            self.assertIsInstance(environment["deepseek_api_key_configured"], bool)
            self.assertNotIn("DEEPSEEK_API_KEY", environment)
            self.assertEqual(environment["config_sources"]["search-plan-v2.json"], "example")

    def test_score_band_stats_endpoint(self):
        response = self.client.get("/api/stats/score-bands")
        self.assertEqual(response.status_code, 200, response.text)
        bands = response.json()["bands"]
        self.assertEqual([x["band"] for x in bands], ["≥80", "65–79", "45–64", "<45", "未评分"])
        self.assertGreaterEqual(bands[0]["jobs"], 1)
        for row in bands:
            self.assertIn("jobs", row)
            for key in ("contacted", "replied", "interview", "offer"):
                self.assertIn(key, row)
                self.assertIn(f"{key}_rate", row)
                self.assertGreaterEqual(row[f"{key}_rate"], 0)

    def test_llm_env_precedence_and_optional_thinking(self):
        import json
        from unittest.mock import MagicMock
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({"choices": [{"message": {"content": '{"reply":"ok"}'}}]}).encode()
        with patch.dict("os.environ", {"LLM_API_KEY": "new-key", "LLM_BASE_URL": "https://provider.example/v1", "LLM_MODEL": "provider-model", "LLM_THINKING": "", "LLM_MAX_TOKENS": "1234", "DEEPSEEK_API_KEY": "old-key"}, clear=False), patch.object(self.main.common.urllib.request, "urlopen", return_value=response) as urlopen:
            result, model = self.main.common.call_reply_model({"text": "mock"})
        sent = json.loads(urlopen.call_args.args[0].data)
        self.assertEqual(model, "provider-model")
        self.assertNotIn("thinking", sent)
        self.assertEqual(sent["max_tokens"], 1234)
        self.assertEqual(urlopen.call_args.args[0].full_url, "https://provider.example/v1/chat/completions")
        self.assertEqual(urlopen.call_args.args[0].get_header("Authorization"), "Bearer new-key")

    def test_profile_draft_masks_and_does_not_save(self):
        from unittest.mock import patch
        captured = {}
        def mocked(masked):
            captured["text"] = masked
            return {"positioning": "draft", "education": [], "verified_evidence": ["明确成果"], "target_directions": [], "preferred_locations": [], "evidence_boundaries": []}
        before = self.client.get("/api/settings/candidate-profile").json()["value"]
        with patch.dict("os.environ", {}, clear=True):
            missing_key = self.client.post("/api/settings/candidate-profile/draft", json={"resume_text": "resume"})
        self.assertEqual(missing_key.status_code, 503)
        self.assertIn("LLM_API_KEY", missing_key.json()["detail"])
        with patch.dict("os.environ", {"LLM_API_KEY": "mock-key"}, clear=False), patch.object(self.main.settings, "call_profile_draft_model", side_effect=mocked):
            response = self.client.post("/api/settings/candidate-profile/draft", json={"resume_text": "张三\n电话 13812345678 邮箱 a@example.com 微信: wx_abcde12 身份证 110105199001011234"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn("13812345678", captured["text"])
        self.assertNotIn("a@example.com", captured["text"])
        self.assertNotIn("wx_abcde12", captured["text"])
        self.assertNotIn("110105199001011234", captured["text"])
        self.assertTrue(captured["text"].startswith("[姓名已隐藏]"))
        self.assertFalse(response.json()["saved"])
        self.assertEqual(self.client.get("/api/settings/candidate-profile").json()["value"], before)

    def test_panel_tasks_whitelist_budget_lock_and_stop(self):
        from unittest.mock import patch, MagicMock
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            budget = {"date": "today", "policy": {"daily_caps": {p: {"detail_opens": 10, "chat_opens": 10} for p in ("boss", "liepin")}}, "usage": {}, "cooldowns": {}}
            fake = MagicMock(); fake.pid = 4321; fake.poll.return_value = None
            with patch.object(self.main.tasks, "PROJECT_ROOT", root), patch.object(self.main.common, "PROJECT_ROOT", root), patch.object(self.main.tasks, "get_automation_budget", return_value=budget), patch.object(self.main.tasks.subprocess, "Popen", return_value=fake) as popen:
                started = self.client.post("/api/tasks/collect-plan-dry-run")
                self.assertEqual(started.status_code, 200, started.text)
                self.assertEqual(popen.call_args.args[0], ["node", "src/collect-plan.js", "--dry-run"])
                task_id = started.json()["running"]["id"]
                self.assertEqual(self.client.post("/api/tasks/arbitrary-command").status_code, 404)
                stopped = self.client.post(f"/api/tasks/{task_id}/stop")
                self.assertEqual(stopped.status_code, 200, stopped.text)
                fake.terminate.assert_called_once()
            exhausted = {"policy": {"daily_caps": {p: {"detail_opens": 1, "chat_opens": 1} for p in ("boss", "liepin")}}, "usage": {p: {"detail_opens": 1, "chat_opens": 0} for p in ("boss", "liepin")}, "cooldowns": {}}
            with patch.object(self.main.tasks, "PROJECT_ROOT", root), patch.object(self.main.common, "PROJECT_ROOT", root), patch.object(self.main.tasks, "get_automation_budget", return_value=exhausted), patch.object(self.main.tasks.subprocess, "Popen") as popen:
                self.assertEqual(self.client.post("/api/tasks/chat-pipeline").status_code, 409)
                popen.assert_not_called()
            cooling = {**budget, "cooldowns": {"boss": "2099-01-01T00:00:00+08:00"}}
            with patch.object(self.main.tasks, "PROJECT_ROOT", root), patch.object(self.main.common, "PROJECT_ROOT", root), patch.object(self.main.tasks, "get_automation_budget", return_value=cooling), patch.object(self.main.tasks.subprocess, "Popen") as popen:
                self.assertEqual(self.client.post("/api/tasks/chat-pipeline").status_code, 409)
                popen.assert_not_called()
            lock_dir = root / ".run"; lock_dir.mkdir(parents=True)
            (lock_dir / "browser-automation.lock").write_text(__import__('json').dumps({"pid": __import__('os').getpid(), "kind":"collect"}))
            with patch.object(self.main.tasks, "PROJECT_ROOT", root), patch.object(self.main.common, "PROJECT_ROOT", root), patch.object(self.main.tasks, "get_automation_budget", return_value=budget), patch.object(self.main.tasks.subprocess, "Popen") as popen:
                self.assertEqual(self.client.get("/api/tasks").json()["running"]["name"], "collect")
                blocked = self.client.post("/api/tasks/chat-pipeline")
                self.assertEqual(blocked.status_code, 409)
                popen.assert_not_called()

    def test_direction_validation_uses_configured_ids(self):
        with tempfile.TemporaryDirectory() as temp:
            config = Path(temp)
            (config / "search-plan-v2.json").write_text(
                '{"directions":[{"id":"custom_role","label":"自定义方向"}]}', encoding="utf-8")
            with patch.object(self.main.common, "CONFIG_DIR", config):
                valid = self.client.post("/api/search-runs", json={"source": "boss", "keyword": "测试词", "search_direction": "custom_role"})
                invalid = self.client.post("/api/search-runs", json={"source": "boss", "keyword": "测试词", "search_direction": "unknown_role"})
            self.assertEqual(valid.status_code, 200, valid.text)
            self.assertEqual(invalid.status_code, 422)


if __name__ == "__main__":
    unittest.main()
