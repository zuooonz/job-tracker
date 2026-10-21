#!/usr/bin/env python3
"""生成演示数据库：全部为虚构岗位、公司和沟通记录，不含任何真实数据。

用法:
    python3 scripts/seed_demo.py              # 生成 data/demo.sqlite3（已存在则覆盖）
    python3 scripts/seed_demo.py --db /tmp/x.sqlite3
    ./scripts/manage.sh demo                  # 生成后以演示数据库启动前后端
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
TZ = ZoneInfo("Asia/Shanghai")


def ts(days_ago: float, hour: int = 10, minute: int = 0) -> str:
    base = datetime.now(TZ).replace(hour=hour, minute=minute, second=0, microsecond=0)
    return (base - timedelta(days=days_ago)).isoformat(timespec="seconds")


JOBS = [
    {
        "job": {
            "source": "boss", "url": "https://www.zhipin.com/job_detail/demo-data-pm-001.html",
            "title": "数据产品经理（指标平台）", "company": "示例云数据科技", "location": "示例地点",
            "salary": "25-40K·14薪", "experience": "3-5年", "education": "本科",
            "job_tags": ["数据产品", "指标体系", "BI"], "benefits": ["五险一金", "弹性工作"],
            "recruiter_name": "招聘者", "recruiter_title": "HRBP", "publisher_type": "company_hr",
            "company_industry": "企业服务", "company_size": "500-999人", "company_stage": "C轮",
            "jd": "负责公司指标平台产品规划：梳理业务指标口径，设计指标管理、血缘和权限功能；"
                  "与数据开发、分析团队协作推进指标体系落地；跟踪平台使用数据持续迭代。"
                  "要求 3 年以上数据产品经验，熟悉数仓分层与 SQL，有 BI 或数据中台项目经验优先。",
        },
        "evaluation": (86, "priority", "指标体系与数据平台经验高度匹配，薪资与地点符合预期。"),
        "application": "interview",
        "chat": [
            ("out", "您好，我做过两年指标平台和数据质量相关的产品，对这个岗位很感兴趣。", 6, 10, 2),
            ("in", "你好，方便发一份简历吗？", 6, 10, 30),
            ("out", "已发送，请查收。", 6, 10, 35),
            ("in", "简历看过了，想约你周四下午 3 点线上聊一下，可以吗？", 5, 14, 5),
            ("out", "可以的，周四下午 3 点见。", 5, 14, 20),
        ],
    },
    {
        "job": {
            "source": "liepin", "url": "https://www.liepin.com/job/demo0000002.shtml",
            "title": "AI 应用产品经理（知识库方向）", "company": "示例智能信息", "location": "示例地点",
            "salary": "30-50k", "experience": "3-5年", "education": "硕士",
            "job_tags": ["大模型", "RAG", "知识库"], "benefits": ["年终奖", "补充保险"],
            "recruiter_name": "招聘者", "recruiter_title": "猎头顾问", "publisher_type": "headhunter",
            "company_industry": "人工智能", "company_size": "100-499人", "company_stage": "B轮",
            "jd": "负责企业知识库与智能问答产品：设计资料解析、检索、引用核验和人工审核流程；"
                  "定义效果评测集与上线指标；对接客户需求完成试点交付。有 RAG 项目落地经验优先。",
        },
        "evaluation": (78, "normal", "有知识库试点证据，但缺少规模化商业交付经验。"),
        "application": "contacted",
        "chat": [
            ("out", "您好，我做过企业知识库 RAG 试点，想了解一下这个岗位。", 3, 11, 0),
            ("in", "您好，这个岗位客户是金融行业，目前在推进第二轮面试，您的薪资范围是多少？", 2, 16, 40),
        ],
    },
    {
        "job": {
            "source": "boss", "url": "https://www.zhipin.com/job_detail/demo-analyst-003.html",
            "title": "商业数据分析师", "company": "示例零售集团", "location": "示例地点",
            "salary": "20-30K", "experience": "1-3年", "education": "本科",
            "job_tags": ["SQL", "Python", "经营分析"], "benefits": ["餐补", "定期体检"],
            "recruiter_name": "招聘者", "recruiter_title": "招聘经理", "publisher_type": "company_hr",
            "company_industry": "零售", "company_size": "10000人以上", "company_stage": "已上市",
            "jd": "负责门店经营分析与周报体系建设，搭建用户分层与留存分析模型，"
                  "支持运营策略 A/B 实验评估。熟练使用 SQL、Python，有零售或电商分析经验优先。",
        },
        "evaluation": (64, "opportunity", "分析技能匹配，但岗位职级偏低、业务领域不在主线。"),
        "application": "contacted",
        "chat": [
            ("out", "您好，我对用户分层和留存分析比较熟悉，想进一步了解岗位。", 9, 9, 30),
            ("in", "感谢关注，您的经历与岗位目标画像不太符合，祝求职顺利。", 8, 18, 10),
        ],
    },
    {
        "job": {
            "source": "liepin", "url": "https://www.liepin.com/job/demo0000004.shtml",
            "title": "数据治理项目经理", "company": "示例数字政务", "location": "示例地点",
            "salary": "25-35k", "experience": "5-10年", "education": "本科",
            "job_tags": ["数据治理", "项目管理", "数据标准"], "benefits": ["五险一金"],
            "recruiter_name": "招聘者", "recruiter_title": "HR", "publisher_type": "company_hr",
            "company_industry": "IT服务", "company_size": "1000-9999人", "company_stage": "不需要融资",
            "jd": "负责政务数据治理项目整体交付：制定数据标准与质量规则，组织数据清洗、"
                  "元数据管理和质量稽核；管理项目进度、风险与客户沟通。有 PMP 证书优先。",
        },
        "evaluation": (72, "normal", "数据质量与治理证据充分，项目规模和年限略低于要求。"),
        "application": "applied",
        "chat": [
            ("out", "您好，我想应聘贵公司的数据治理项目经理职位，期盼回复，谢谢。", 4, 15, 0),
            ("system", "[投递反馈] 已查看", 3, 9, 20),
        ],
    },
    {
        "job": {
            "source": "boss", "url": "https://www.zhipin.com/job_detail/demo-agent-005.html",
            "title": "Agent 产品经理", "company": "示例未来机器人", "location": "示例地点",
            "salary": "35-60K·15薪", "experience": "3-5年", "education": "本科",
            "job_tags": ["Agent", "大模型应用", "B端"], "benefits": ["股票期权", "免费三餐"],
            "recruiter_name": "招聘者", "recruiter_title": "产品总监", "publisher_type": "direct_manager",
            "company_industry": "人工智能", "company_size": "100-499人", "company_stage": "A轮",
            "jd": "负责企业级 Agent 平台的工作流编排、工具调用和效果评测产品设计，"
                  "深入客户场景提炼通用能力。要求有 AI 应用产品经验，能独立完成需求到上线全流程。",
        },
        "evaluation": (81, "priority", "AI 应用落地经验直接相关，团队阶段与成长价值较高。"),
        "application": "not_started",
        "chat": [],
    },
    {
        "job": {
            "source": "liepin", "url": "https://www.liepin.com/job/demo0000006.shtml",
            "title": "BI 产品专家", "company": "示例金融科技", "location": "示例地点",
            "salary": "40-60k", "experience": "5-10年", "education": "本科",
            "job_tags": ["BI", "数据可视化"], "benefits": ["年终奖"],
            "recruiter_name": "招聘者", "recruiter_title": "HR", "publisher_type": "company_hr",
            "company_industry": "金融科技", "company_size": "1000-9999人", "company_stage": "已上市",
            "jd": "负责自助 BI 产品规划与竞品研究，带领 3-5 人产品小组。要求 5 年以上 BI 产品经验，需常驻示例地点。",
        },
        "evaluation": (48, "opportunity", "地点不符且要求带团队经验，作为观察岗位。"),
        "application": "closed",
        "chat": [
            ("out", "您好，想了解一下这个岗位是否接受远程办公。", 12, 10, 0),
        ],
    },
]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default=str(ROOT / "data" / "demo.sqlite3"))
    args = parser.parse_args()

    db_path = Path(args.db).resolve()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    for suffix in ("", "-wal", "-shm"):
        Path(f"{db_path}{suffix}").unlink(missing_ok=True)
    os.environ["TRACKER_DB_PATH"] = str(db_path)
    os.environ["TRACKER_DEMO"] = "1"
    # 演示只用公开示例配置：复制到独立目录，避免读到本机 config/private/ 里的个人配置
    demo_config = Path(os.environ.get("TRACKER_CONFIG_DIR") or db_path.parent / "demo-config")
    if demo_config.resolve() != (ROOT / "automation" / "config").resolve():
        demo_config.mkdir(parents=True, exist_ok=True)
        for source in (ROOT / "automation" / "config").glob("*"):
            if source.is_file():
                (demo_config / source.name).write_bytes(source.read_bytes())
        os.environ["TRACKER_CONFIG_DIR"] = str(demo_config)
    sys.path.insert(0, str(ROOT / "backend"))

    from fastapi.testclient import TestClient
    import main as app_main

    with TestClient(app_main.app) as client:
        for item in JOBS:
            job = client.post("/api/jobs", json={**item["job"], "metadata": {"demo": True}})
            job.raise_for_status()
            job_id = job.json()["id"]
            score, level, summary = item["evaluation"]
            client.post(f"/api/jobs/{job_id}/evaluations", json={
                "strategy_version": "demo", "evaluator": "demo", "relevance_score": score,
                "recommendation_level": level, "direction": "product_role", "summary": summary,
                "match_evidence": ["演示数据"], "provider": "demo", "model_name": "demo",
                "confidence_score": 80,
            }).raise_for_status()
            if item["application"] != "not_started":
                client.patch(f"/api/jobs/{job_id}/application",
                             json={"status": item["application"]}).raise_for_status()
            if item["chat"]:
                messages = [{"direction": d, "content": c, "sent_at": ts(days, h, m)}
                            for d, c, days, h, m in item["chat"]]
                client.post(f"/api/jobs/{job_id}/chat",
                            json={"source": item["job"]["source"], "messages": messages}).raise_for_status()
        total = len(client.get("/api/jobs").json())
    print(f"演示数据库已生成：{db_path}（{total} 个虚构岗位）")


if __name__ == "__main__":
    main()
