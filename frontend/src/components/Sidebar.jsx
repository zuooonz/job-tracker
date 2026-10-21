import React from 'react';

export default function FunnelSidebar({ stages, labels, active, stats, onSelect }) {
  return <div className="nav-group">
    <div className="nav-group-title">求职漏斗</div>
    {stages.map(status => <button key={status} className={`nav-sub-item ${active === status ? 'active' : ''}`} onClick={() => onSelect(status)}>
      <span>{labels[status]}</span><span className="nav-sub-item-count">{status === 'all' ? stats.total ?? 0 : stats.funnel_statuses?.[status] || 0}</span>
    </button>)}
  </div>;
}
