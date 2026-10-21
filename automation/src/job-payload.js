function detailToPayload(source, detail, discovery = undefined) {
  return {
    source, url: detail.url, title: detail.title, company: detail.company,
    location: detail.location, salary: detail.salary, update_time: detail.updateTime || '',
    relative_update_time: detail.relativeUpdateTime || '', listing_status: detail.listingStatus || '',
    experience: detail.experience || '', education: detail.education || '', headcount: detail.headcount || '',
    job_tags: detail.jobTags || [], benefits: detail.benefits || [],
    recruiter_name: detail.recruiterName || '', recruiter_title: detail.recruiterTitle || '',
    recruiter_company: detail.recruiterCompany || '', recruiter_tags: detail.recruiterTags || [],
    recruiter_activity: detail.recruiterActivity || '', recruiter_verified: detail.recruiterVerified ?? null,
    publisher_type: detail.publisherType || 'unknown', company_industry: detail.companyIndustry || '',
    company_size: detail.companySize || '', company_stage: detail.companyStage || '',
    work_address: detail.workAddress || '', metadata: detail.metadata || {},
    jd: detail.description || '',
    ...(discovery ? { discovery } : {})
  };
}

module.exports = { detailToPayload };
