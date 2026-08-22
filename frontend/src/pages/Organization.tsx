import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Users, Briefcase, Crown, ChevronLeft, ChevronRight, GitBranch, ArrowUpRight, Network, ChevronDown, ListTree, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { fetchExplorer, OrgExplorerLegend, searchPeople, managerChain, directReports, type Dept, type Pos, type Person, type ExplorerData } from '../components/org/OrgExplorer';
import { OrgGraphView } from '../components/org/OrgGraphView';
import { layoutOrgGraph, type OrgGraphLayout } from '../lib/orgGraph';
import { api } from '../api/client';
import clsx from 'clsx';

export function Organization() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['org-explorer'],
    queryFn: fetchExplorer,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [fullscreen, setFullscreen] = useState(false);
  const [listMode, setListMode] = useState(false);
  const [focusRequest, setFocusRequest] = useState<{ id: string; ts: number } | null>(null);

  // default posture: on large orgs, start with occupants collapsed (overview mode)
  useEffect(() => {
    if (!data || data.people.length <= 150 || collapsed.size > 0) return;
    const all = new Set<string>();
    for (const p of data.positions) all.add(p.id);
    setCollapsed(all);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const expandAll = () => setCollapsed(new Set());
  const collapseAll = () => {
    if (!data) return;
    const all = new Set<string>();
    for (const d of data.departments) all.add(d.id);
    for (const p of data.positions) all.add(p.id);
    setCollapsed(all);
  };

  const select = (id: string | null) => {
    setSelectedId(id);
  };

  const focusPerson = (id: string) => {
    select(id);
    setFocusRequest({ id, ts: Date.now() });
    const person = data?.people.find((p) => p.id === id);
    if (person) {
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(person.position_id!);
        next.delete(person.department_id!);
        return next;
      });
    }
  };

  // graph layout (elk, async, cached by signature)
  const graphRef = useRef<{ key: string; layout: OrgGraphLayout } | null>(null);
  const [layoutPending, setLayoutPending] = useState(false);
  const layoutKey = data ? `${data.departments.length}|${data.positions.length}|${data.people.length}|${[...collapsed].sort().join(',')}` : '';
  useEffect(() => {
    if (!data) return;
    if (graphRef.current && graphRef.current.key === layoutKey) return;
    let cancelled = false;
    setLayoutPending(true);
    void layoutOrgGraph(data, collapsed).then((layout) => {
      if (cancelled) return;
      graphRef.current = { key: layoutKey, layout };
      setLayoutPending(false);
    });
    return () => { cancelled = true; };
  }, [data, layoutKey, collapsed]);

  const graphLayout = graphRef.current?.key === layoutKey ? graphRef.current.layout : null;

  const results = useMemo(() => (data ? searchPeople(data, query) : []), [data, query]);

  const deptById = useMemo(() => new Map((data?.departments ?? []).map((d) => [d.id, d])), [data]);
  const posById = useMemo(() => new Map((data?.positions ?? []).map((p) => [p.id, p])), [data]);
  const personById = useMemo(() => new Map((data?.people ?? []).map((p) => [p.id, p])), [data]);

  const selectedPerson = selectedId && selectedId !== 'org-root' ? personById.get(selectedId) : null;
  const selectedDept = selectedId && selectedId !== 'org-root' ? deptById.get(selectedId) : null;
  const selectedPos = selectedId && selectedId !== 'org-root' ? posById.get(selectedId) : null;
  const orgSelected = selectedId === 'org-root';

  const chain = selectedPerson ? managerChain(data!, selectedPerson.id) : [];
  const reports = selectedPerson ? directReports(data!, selectedPerson.id) : [];
  const deptMembers = selectedDept ? (data?.people.filter((p) => p.department_id === selectedDept.id) ?? []) : [];

  const { data: teamHealth, refetch: refetchHealth } = useQuery({
    queryKey: ['team-health', selectedDept?.id ?? ''],
    queryFn: async () => (await api.get('/team-health', { params: { department_id: selectedDept!.id } })).data,
    enabled: Boolean(selectedDept),
    retry: false,
  });

  const { data: teamWorkload } = useQuery({
    queryKey: ['team-workload', selectedDept?.id ?? ''],
    queryFn: async () => (await api.get('/workload/team', { params: { department_id: selectedDept!.id } })).data,
    enabled: Boolean(selectedDept),
    retry: false,
  });

  const { data: scorecard } = useQuery({
    queryKey: ['scorecard', selectedDept?.id ?? ''],
    queryFn: async () => (await api.get('/leadership/scorecard', { params: { department_id: selectedDept!.id } })).data,
    enabled: Boolean(selectedDept),
    retry: false,
  });

  const openPositions = useMemo(() => {
    if (!data) return [];
    return data.positions.filter((p) => !data.people.some((pp) => pp.position_id === p.id));
  }, [data]);

  return (
    <div className="space-y-8">
      <section className="animate-fade-in">
        <p className="eyebrow">Organization</p>
        <h1 className="h-page mt-1">Organization explorer</h1>
        <p className="prose-muted mt-2 max-w-xl">
          Who reports to whom, which team everyone sits in, who leads what — search, expand and focus the structure.
        </p>
      </section>

      <section className="animate-slide-up flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-inkfaint" strokeWidth={2} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search people, roles, skills, projects…"
            className="w-full rounded-md border border-line bg-surface py-2 pl-9 pr-3 text-sm text-ink outline-none transition-colors focus:border-inkfaint"
            aria-label="Search the organization"
          />
        </div>
        <span className="ml-auto text-2xs text-inkfaint">
          {data?.departments.length ?? '—'} departments · {data?.positions.length ?? '—'} roles · {data?.people.length ?? '—'} people
        </span>
      </section>

      {query.trim() && (
        <section className="animate-slide-up rounded-lg border border-line bg-surface p-4">
          <p className="eyebrow">Matches</p>
          {results.length === 0 ? (
            <p className="mt-2 text-sm text-inkfaint">No one matches “{query}”. Try a name, skill or project.</p>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              {results.map((p) => (
                <button
                  key={p.id}
                  onClick={() => focusPerson(p.id)}
                  className="group inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-ink transition-colors hover:border-brand hover:bg-brandsoft"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-brand" />
                  {p.name}
                  <span className="text-2xs text-inkfaint">
                    {p.position_id ? posById.get(p.position_id)?.title : 'Unassigned'}
                  </span>
                  <ArrowUpRight className="h-3 w-3 text-inkfaint transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" strokeWidth={2} />
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start lg:gap-6">
        <div className="space-y-8">
          <section className="animate-slide-up hidden overflow-hidden rounded-lg border border-line bg-surface md:block">
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setListMode(false)}
                  className={clsx('inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors', !listMode ? 'bg-ink text-surface' : 'text-inksoft hover:bg-soft')}
                  aria-pressed={!listMode}
                >
                  <Network className="h-3.5 w-3.5" strokeWidth={2} /> Graph
                </button>
                <button
                  onClick={() => setListMode(true)}
                  className={clsx('inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors', listMode ? 'bg-ink text-surface' : 'text-inksoft hover:bg-soft')}
                  aria-pressed={listMode}
                >
                  <ListTree className="h-3.5 w-3.5" strokeWidth={2} /> List
                </button>
              </div>
              <div className="ml-auto flex items-center gap-1.5">
                <button onClick={expandAll} className="inline-flex items-center gap-1 rounded-md border border-line px-2.5 py-1.5 text-2xs text-inksoft transition-colors hover:bg-soft" title="Expand everything">
                  <ChevronsDownUp className="h-3.5 w-3.5" strokeWidth={2} /> Expand all
                </button>
                <button onClick={collapseAll} className="inline-flex items-center gap-1 rounded-md border border-line px-2.5 py-1.5 text-2xs text-inksoft transition-colors hover:bg-soft" title="Collapse to departments">
                  <ChevronsUpDown className="h-3.5 w-3.5" strokeWidth={2} /> Collapse all
                </button>
              </div>
            </div>
            {isLoading ? (
              <div className="skeleton m-4 h-[560px]" />
            ) : error ? (
              <div className="empty-state">
                <p className="text-sm font-medium text-ink">Could not load the organization</p>
                <p className="mt-1 text-xs text-inkfaint">The structure service is unavailable right now.</p>
              </div>
            ) : !data || data.departments.length === 0 ? (
              <div className="empty-state">
                <p className="text-sm font-medium text-ink">No organization data</p>
                <p className="mt-1 text-xs text-inkfaint">The organization structure is being provisioned.</p>
              </div>
            ) : listMode ? (
              <OrgListTree
                data={data}
                collapsed={collapsed}
                onToggle={toggle}
                onSelect={select}
                selectedId={selectedId}
              />
            ) : (
              <div className="relative">
                {layoutPending && !graphLayout && <div className="skeleton absolute inset-0 z-10 m-4 h-[560px] rounded-lg" />}
                {graphLayout && (
                  <OrgGraphView
                    data={data}
                    layout={graphLayout}
                    collapsed={collapsed}
                    onToggle={toggle}
                    selectedId={selectedId}
                    onSelect={select}
                    fullscreen={fullscreen}
                    onToggleFullscreen={() => setFullscreen((f) => !f)}
                    focusRequest={focusRequest}
                  />
                )}
                <div className="border-t border-line px-4 py-3">
                  <OrgExplorerLegend />
                </div>
              </div>
            )}
          </section>

          <section className="animate-slide-up md:hidden">
            <div className="rounded-lg border border-line bg-surface">
              <div className="border-b border-line px-4 py-3">
                <p className="eyebrow">Structure · compact list</p>
              </div>
              {data && (
                <MobileTree
                  data={data}
                  collapsed={collapsed}
                  onToggleDept={toggle}
                  onSelect={select}
                  selectedId={selectedId}
                />
              )}
            </div>
          </section>
        </div>

        <aside className="elev-2 animate-slide-up rounded-lg border border-line bg-surface lg:sticky lg:top-24" aria-label="Inspector">
          <div className="section-rule px-5 pt-4">
            <h2 className="h-section">Inspector</h2>
          </div>
          <div className="max-h-[70vh] overflow-y-auto lg:max-h-[calc(100vh-12rem)]">
            {orgSelected && data ? (
              <OrgOverview
                data={data}
                openPositions={openPositions}
                onSelect={select}
              />
            ) : selectedPerson ? (
              <PersonDetail
                person={selectedPerson}
                pos={selectedPerson.position_id ? posById.get(selectedPerson.position_id) ?? null : null}
                dept={selectedPerson.department_id ? deptById.get(selectedPerson.department_id) ?? null : null}
                chain={chain}
                reports={reports}
                onFocus={(id) => focusPerson(id)}
                onShowDept={(id) => select(id)}
              />
            ) : selectedDept ? (
              <DeptDetail
                dept={selectedDept}
                people={deptMembers}
                positions={(data?.positions ?? []).filter((p) => p.department_id === selectedDept.id)}
                teamHealth={teamHealth}
                teamWorkload={teamWorkload}
                scorecard={scorecard}
                onRefresh={() => { void refetchHealth(); }}
                onSelectPerson={focusPerson}
                onSelectPos={select}
              />
            ) : selectedPos ? (
            <PosDetail
              pos={selectedPos}
              dept={selectedPos.department_id ? deptById.get(selectedPos.department_id) ?? null : null}
              holder={selectedPos.head_of_department_id ? personById.get(selectedPos.head_of_department_id) ?? null : (data?.people.find((p) => p.position_id === selectedPos.id) ?? null)}
              reports={(data?.people ?? []).filter((p) => (data?.positions ?? []).find((x) => x.id === p.position_id)?.parent_position_id === selectedPos.id)}
              onFocus={focusPerson}
            />
          ) : (
            <div className="empty-state">
              <p className="text-sm font-medium text-ink">Select something in the chart</p>
              <p className="mt-1 text-xs text-inkfaint">
                Click the organization node for an overview, a department to focus its cluster, a role card, or any person to inspect reporting lines, skills and projects.
              </p>
            </div>
          )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function OrgOverview({ data, openPositions, onSelect }: {
  data: ExplorerData; openPositions: Pos[];
  onSelect: (id: string | null) => void;
}) {
  const heads = data.departments.filter((d) => d.head_person_id).length;
  return (
    <div className="divide-y divide-line">
      <div className="px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-ink">
            <Network className="h-4 w-4 text-surface" strokeWidth={2} />
          </div>
          <div>
            <p className="font-display text-lg font-medium text-ink">EduRankAI</p>
            <p className="text-xs text-inksoft">Organization · full structure</p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <div className="rounded-md border border-line bg-soft/40 p-3">
            <p className="text-2xs uppercase tracking-[0.12em] text-inkfaint">Departments</p>
            <p className="mt-1 font-display text-2xl text-ink">{data.departments.length}</p>
          </div>
          <div className="rounded-md border border-line bg-soft/40 p-3">
            <p className="text-2xs uppercase tracking-[0.12em] text-inkfaint">People</p>
            <p className="mt-1 font-display text-2xl text-ink">{data.people.length}</p>
          </div>
          <div className="rounded-md border border-line bg-soft/40 p-3">
            <p className="text-2xs uppercase tracking-[0.12em] text-inkfaint">Roles</p>
            <p className="mt-1 font-display text-2xl text-ink">{data.positions.length}</p>
            <p className="text-2xs text-inkfaint">{heads} led by department heads</p>
          </div>
          <div className="rounded-md border border-line bg-brandsoft/40 p-3">
            <p className="text-2xs uppercase tracking-[0.12em] text-branddeep">Open roles</p>
            <p className="mt-1 font-display text-2xl text-ink">{openPositions.length}</p>
          </div>
        </div>
      </div>
      <div className="px-5 py-4">
        <p className="eyebrow">Departments</p>
        <div className="mt-3 space-y-1">
          {data.departments.map((d) => {
            const count = data.people.filter((p) => p.department_id === d.id).length;
            return (
              <button
                key={d.id}
                onClick={() => onSelect(d.id)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-soft"
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">{d.name}</span>
                <span className="text-2xs text-inkfaint">{count} {count === 1 ? 'person' : 'people'}</span>
                <ChevronRight className="h-3 w-3 shrink-0 text-inkfaint" strokeWidth={2} />
              </button>
            );
          })}
        </div>
      </div>
      {openPositions.length > 0 && (
        <div className="px-5 py-4">
          <p className="eyebrow">Open positions</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {openPositions.map((p) => (
              <button
                key={p.id}
                onClick={() => onSelect(p.id)}
                className="inline-flex items-center gap-1.5 rounded-full border border-brand/40 bg-brandsoft/30 px-2.5 py-1 text-2xs font-medium text-branddeep transition-colors hover:border-brand"
              >
                <Briefcase className="h-3 w-3" strokeWidth={2} /> {p.title}
              </button>
            ))}
          </div>
          <p className="mt-3 text-2xs text-inkfaint">Click a role to inspect it, or use the graph to see it in context.</p>
        </div>
      )}
    </div>
  );
}

function OrgListTree({ data, collapsed, onToggle, onSelect, selectedId }: {
  data: ExplorerData; collapsed: Set<string>;
  onToggle: (id: string) => void; onSelect: (id: string | null) => void; selectedId: string | null;
}) {
  return (
    <div className="max-h-[calc(100vh-16rem)] overflow-y-auto px-4 py-3" role="tree" aria-label="Organization structure">
      <ul role="group">
        {data.departments.map((d) => (
          <OrgListDept key={d.id} d={d} data={data} collapsed={collapsed} onToggle={onToggle} onSelect={onSelect} selectedId={selectedId} />
        ))}
      </ul>
    </div>
  );
}

function OrgListDept({ d, data, collapsed, onToggle, onSelect, selectedId }: {
  d: Dept; data: ExplorerData; collapsed: Set<string>;
  onToggle: (id: string) => void; onSelect: (id: string | null) => void; selectedId: string | null;
}) {
  const positions = data.positions.filter((p) => p.department_id === d.id);
  const members = data.people.filter((p) => p.department_id === d.id);
  const isCollapsed = collapsed.has(d.id);
  return (
    <li className="py-0.5" role="treeitem" aria-expanded={!isCollapsed}>
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => onToggle(d.id)}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-inkfaint transition-colors hover:bg-soft"
          aria-label={isCollapsed ? `Expand ${d.name}` : `Collapse ${d.name}`}
        >
          {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" strokeWidth={2} /> : <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} />}
        </button>
        <button
          onClick={() => onSelect(d.id)}
          className={clsx(
            'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
            selectedId === d.id ? 'bg-ink text-surface' : 'hover:bg-soft'
          )}
        >
          <span className="h-2 w-2 shrink-0 rounded-sm bg-brand" />
          <span className="truncate font-display text-sm font-semibold">{d.name}</span>
          <span className={clsx('ml-auto shrink-0 text-2xs', selectedId === d.id ? 'opacity-70' : 'text-inkfaint')}>
            {positions.length} roles · {members.length} people{d.head_name ? ` · ${d.head_name} leads` : ''}
          </span>
        </button>
      </div>
      {!isCollapsed && (
        <ul className="ml-4 border-l border-line pl-2" role="group">
          {positions.map((p) => (
            <OrgListPos key={p.id} p={p} data={data} collapsed={collapsed} onToggle={onToggle} onSelect={onSelect} selectedId={selectedId} />
          ))}
        </ul>
      )}
    </li>
  );
}

function OrgListPos({ p, data, collapsed, onToggle, onSelect, selectedId }: {
  p: Pos; data: ExplorerData; collapsed: Set<string>;
  onToggle: (id: string) => void; onSelect: (id: string | null) => void; selectedId: string | null;
}) {
  const holders = data.people.filter((pp) => pp.position_id === p.id);
  const isCollapsed = collapsed.has(p.id);
  const isHead = Boolean(p.head_of_department_id);
  return (
    <li className="py-0.5" role="treeitem" aria-expanded={holders.length === 0 ? undefined : !isCollapsed}>
      <div className="flex items-center gap-1.5">
        {holders.length > 0 ? (
          <button
            onClick={() => onToggle(p.id)}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-inkfaint transition-colors hover:bg-soft"
            aria-label={isCollapsed ? `Expand occupants of ${p.title}` : `Collapse occupants of ${p.title}`}
          >
            {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" strokeWidth={2} /> : <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} />}
          </button>
        ) : (
          <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center" />
        )}
        <button
          onClick={() => onSelect(p.id)}
          className={clsx(
            'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
            selectedId === p.id ? 'bg-ink text-surface' : 'hover:bg-soft'
          )}
        >
          <GitBranch className={clsx('h-3.5 w-3.5 shrink-0', selectedId === p.id ? 'opacity-80' : 'text-inkfaint')} strokeWidth={2} />
          <span className="truncate text-xs font-medium">{p.title}</span>
          {isHead && <Crown className={clsx('h-3 w-3 shrink-0', selectedId === p.id ? 'opacity-80' : 'text-brand')} strokeWidth={2} />}
          <span className={clsx('ml-auto shrink-0 text-2xs', selectedId === p.id ? 'opacity-70' : 'text-inkfaint')}>
            {holders.length === 0 ? 'Vacant' : `${holders.length} occupant${holders.length > 1 ? 's' : ''}`}
          </span>
        </button>
      </div>
      {!isCollapsed && holders.length > 0 && (
        <ul className="ml-4 border-l border-line pl-5" role="group">
          {holders.map((h) => (
            <li key={h.id} className="py-0.5" role="treeitem">
              <button
                onClick={() => onSelect(h.id)}
                className={clsx(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors',
                  selectedId === h.id ? 'bg-ink text-surface' : 'text-inksoft hover:bg-soft'
                )}
              >
                <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', selectedId === h.id ? 'bg-surface' : 'bg-brand')} />
                <span className="truncate">{h.name}</span>
                <span className={clsx('ml-auto shrink-0 text-2xs', selectedId === h.id ? 'opacity-70' : 'text-inkfaint')}>{h.grade ?? ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function MobileTree({ data, collapsed, onToggleDept, onSelect, selectedId }: {
  data: ExplorerData; collapsed: Set<string>; onToggleDept: (id: string) => void;
  onSelect: (id: string | null) => void; selectedId: string | null;
}) {
  return (
    <div className="max-h-[28rem] divide-y divide-line overflow-y-auto px-2 py-1">
      {data.departments.map((d) => {
        const positions = data.positions.filter((p) => p.department_id === d.id);
        const isCollapsed = collapsed.has(d.id);
        return (
          <div key={d.id} className="py-2">
            <div className="flex items-center gap-2">
              <button
                onClick={() => onToggleDept(d.id)}
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line text-inkfaint"
                aria-label={isCollapsed ? 'Expand' : 'Collapse'}
              >
                {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" strokeWidth={2} /> : <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} />}
              </button>
              <div className="min-w-0 flex-1">
                <p className="font-display text-sm font-semibold text-ink">{d.name}</p>
                <p className="text-2xs text-inkfaint">
                  {positions.length} roles · {data.people.filter((p) => p.department_id === d.id).length} members
                  {d.head_name ? ` · led by ${d.head_name}` : ''}
                </p>
              </div>
            </div>
            {!isCollapsed && (
              <div className="mt-1 space-y-1 border-l border-line pl-4">
                {positions.map((p) => {
                  const holders = data.people.filter((pp) => pp.position_id === p.id);
                  return (
                    <div key={p.id} className="py-1">
                      <button
                        onClick={() => onSelect(p.id)}
                        className="flex w-full items-center gap-1.5 text-left text-xs font-medium text-ink"
                      >
                        <GitBranch className="h-3 w-3 shrink-0 text-inkfaint" strokeWidth={2} />
                        {p.title}
                        {p.head_of_department_id && <Crown className="h-3 w-3 shrink-0 text-brand" strokeWidth={2} />}
                      </button>
                      <div className="mt-0.5 space-y-0.5 pl-5">
                        {holders.length === 0 && <p className="text-2xs text-inkfaint">Vacant role</p>}
                        {holders.map((h) => (
                          <button
                            key={h.id}
                            onClick={() => onSelect(h.id)}
                            className={clsx(
                              'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors',
                              selectedId === h.id ? 'bg-ink text-surface' : 'text-inksoft hover:bg-soft'
                            )}
                          >
                            <span className={clsx('h-1.5 w-1.5 rounded-full', selectedId === h.id ? 'bg-surface' : 'bg-brand')} />
                            {h.name}
                            <span className="ml-auto text-2xs opacity-70">{h.grade ?? ''}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RelationshipGraph({ person, dept, pos, chain, onFocus }: {
  person: Person; dept: Dept | null; pos: Pos | null;
  chain: { label: string; personId: string | null }[];
  onFocus: (id: string) => void;
}) {
  const manager = chain[0] ?? null;
  return (
    <div className="px-5 py-4">
      <div className="flex items-center gap-2">
        <Network className="h-3.5 w-3.5 text-brand" strokeWidth={2} />
        <p className="eyebrow">Relationship</p>
      </div>
      <div className="mt-3 flex items-start gap-2 overflow-x-auto pb-1">
        {manager && (
          <>
            <div className="min-w-0">
              <button onClick={() => manager.personId && onFocus(manager.personId)} className="block max-w-[10rem] truncate rounded-lg border border-line bg-soft/60 px-3 py-2 text-left transition-colors hover:border-brand">
                <p className="truncate text-xs font-semibold text-ink">{manager.label.split(' — ')[0]}</p>
                <p className="truncate text-2xs text-inkfaint">{manager.label.split(' — ')[1] ?? 'Manager'}</p>
              </button>
              <div className="mx-auto h-3 w-px bg-line" />
            </div>
            <p className="pt-2 text-2xs text-inkfaint">reports to</p>
          </>
        )}
        <div className="min-w-0">
          <button onClick={() => onFocus(person.id)} className="block max-w-[10rem] rounded-lg bg-ink px-3 py-2 text-left">
            <p className="truncate text-xs font-semibold text-surface">{person.name}</p>
            <p className="truncate text-2xs text-inkfaint">{pos?.title ?? 'Unassigned role'}</p>
          </button>
          {dept && (
            <>
              <div className="mx-auto h-3 w-px bg-line" />
              <div className="rounded-lg border border-line bg-soft/40 px-3 py-2 text-center">
                <p className="text-2xs font-medium text-inksoft">{dept.name}</p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PersonDetail({ person, pos, dept, chain, reports, onFocus, onShowDept }: {
  person: Person; pos: Pos | null; dept: Dept | null;
  chain: { label: string; personId: string | null }[]; reports: Person[];
  onFocus: (id: string) => void; onShowDept: (id: string) => void;
}) {
  return (
    <div className="divide-y divide-line">
      <div className="px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-ink font-display text-sm font-medium text-surface">
            {person.name.split(' ').map((w) => w[0]).slice(0, 2).join('')}
          </div>
          <div>
            <p className="font-display text-lg font-medium text-ink">{person.name}</p>
            <p className="text-xs text-inksoft">
              {pos?.title ?? 'Unassigned role'}{person.grade ? ` · Grade ${person.grade}` : ''}
              {dept ? ` · ` : ''}
              {dept && (
                <button className="text-ink underline decoration-line underline-offset-2 hover:decoration-brand" onClick={() => onShowDept(dept.id)}>
                  {dept.name}
                </button>
              )}
            </p>
          </div>
          <button
            onClick={() => onFocus(person.id)}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs text-inksoft transition-colors hover:bg-soft"
          >
            <Search className="h-3 w-3" strokeWidth={2} /> Focus in chart
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {person.skills.map((s) => (
            <span key={s} className="rounded-full border border-line bg-soft/50 px-2.5 py-0.5 text-2xs text-inksoft">{s}</span>
          ))}
          {person.skills.length === 0 && <span className="text-2xs text-inkfaint">No skills recorded.</span>}
        </div>
        {person.projects.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Briefcase className="h-3 w-3 text-inkfaint" strokeWidth={2} />
            {person.projects.map((p) => (
              <span key={p} className="rounded-md border border-line px-2 py-0.5 text-2xs text-inksoft">{p}</span>
            ))}
          </div>
        )}
      </div>

      <RelationshipGraph person={person} dept={dept} pos={pos} chain={chain} onFocus={onFocus} />

      <div className="px-5 py-4">
        <p className="eyebrow">Reporting chain</p>
        {chain.length === 0 ? (
          <p className="mt-1 text-sm text-inkfaint">No manager relationships recorded above this role.</p>
        ) : (
          <ol className="mt-3 space-y-2">
            <li className="flex items-center gap-2 text-sm font-medium text-ink">
              <span className="h-2 w-2 rounded-full bg-ink" /> {person.name}
              <span className="text-2xs text-inkfaint">(you are here)</span>
            </li>
            {chain.map((c, i) => (
              <li key={i} className="flex items-center gap-2 text-sm text-inksoft">
                <span className="h-px w-3 bg-line" />
                <ChevronLeft className="h-3 w-3 rotate-180 text-inkfaint" strokeWidth={2} />
                {c.personId ? (
                  <button className="text-ink hover:underline" onClick={() => onFocus(c.personId!)}>{c.label}</button>
                ) : (
                  <span>{c.label}</span>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="px-5 py-4">
        <p className="eyebrow">Direct reports</p>
        {reports.length === 0 ? (
          <p className="mt-1 text-sm text-inkfaint">No direct reports recorded for this person.</p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            {reports.map((r) => (
              <button key={r.id} onClick={() => onFocus(r.id)} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-xs text-ink transition-colors hover:border-inkfaint">
                <Users className="h-3 w-3 text-inkfaint" strokeWidth={2} /> {r.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="px-5 py-4">
        <span className="privacy-tag privacy-private">Personal record · Private</span>
        <p className="mt-2 text-xs leading-relaxed text-inkfaint">
          Directory information shown here is limited to role, grade, skills and projects. Sensitive personal records are visible only to you, your manager, and HR.
        </p>
      </div>
    </div>
  );
}

function DeptDetail({ dept, people, positions, teamHealth, teamWorkload, scorecard, onRefresh, onSelectPerson, onSelectPos }: {
  dept: Dept; people: Person[]; positions: Pos[];
  teamHealth: any; teamWorkload: any; scorecard: any; onRefresh: () => void;
  onSelectPerson: (id: string) => void; onSelectPos: (id: string) => void;
}) {
  return (
    <div className="divide-y divide-line">
      <div className="px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-brandsoft">
            <Briefcase className="h-4 w-4 text-branddeep" strokeWidth={2} />
          </div>
          <div>
            <p className="font-display text-lg font-medium text-ink">{dept.name}</p>
            <p className="text-xs text-inksoft">
              {positions.length} roles · {people.length} members
              {dept.head_name ? ` · led by ${dept.head_name}` : ''}
            </p>
          </div>
        </div>
        {dept.head_person_id && (
          <button
            onClick={() => onSelectPerson(dept.head_person_id!)}
            className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-line bg-soft/50 px-3 py-1 text-xs text-ink transition-colors hover:border-brand"
          >
            <Crown className="h-3 w-3 text-brand" strokeWidth={2} /> {dept.head_name}
          </button>
        )}
      </div>

      <div className="px-5 py-4">
        <p className="eyebrow">Roles</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {positions.map((p) => (
            <button key={p.id} onClick={() => onSelectPos(p.id)} className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs text-ink transition-colors hover:border-inkfaint">
              <GitBranch className="h-3 w-3 text-inkfaint" strokeWidth={2} />
              {p.title}
              {p.head_of_department_id && <Crown className="h-3 w-3 text-brand" strokeWidth={2} />}
            </button>
          ))}
        </div>
        {(() => {
          const open = positions.filter((p) => !people.some((pp) => pp.position_id === p.id));
          if (open.length === 0) return null;
          return (
            <div className="mt-3 rounded-md border border-brand/30 bg-brandsoft/30 p-3">
              <p className="text-2xs font-medium uppercase tracking-[0.14em] text-branddeep">
                Open position{open.length > 1 ? 's' : ''} in {dept.name}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {open.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => onSelectPos(p.id)}
                    className="inline-flex items-center gap-1.5 rounded-full border border-brand/40 bg-surface px-2.5 py-1 text-2xs font-medium text-branddeep transition-colors hover:border-brand"
                  >
                    <Briefcase className="h-3 w-3" strokeWidth={2} /> {p.title}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-2xs text-inkfaint">Click a role to inspect it in the inspector.</p>
            </div>
          );
        })()}
      </div>

      <div className="px-5 py-4">
        <p className="eyebrow">Members</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {people.map((p) => (
            <button key={p.id} onClick={() => onSelectPerson(p.id)} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-xs text-ink transition-colors hover:border-inkfaint">
              <span className="h-1.5 w-1.5 rounded-full bg-brand" /> {p.name}
            </button>
          ))}
          {people.length === 0 && <p className="text-sm text-inkfaint">No members recorded.</p>}
        </div>
      </div>

      {teamHealth && (
        <div className="px-5 py-4">
          <p className="eyebrow">Team health</p>
          {teamHealth.masked ? (
            <p className="mt-1 text-xs leading-relaxed text-inksoft">{teamHealth.message}</p>
          ) : (
            <>
              <div className="mt-3 flex items-end gap-6">
                {teamHealth.distribution.map((d: any) => (
                  <div key={d.state} className="text-center">
                    <p className="text-2xs uppercase tracking-[0.12em] text-inkfaint">{d.state}</p>
                    <p className={clsx('font-display text-2xl', d.count > 0 && (d.state === 'HIGH' || d.state === 'CRITICAL') && 'text-brand', d.state === 'NORMAL' && 'text-ink')}>
                      {d.count}
                    </p>
                    <p className="text-2xs text-inkfaint">members</p>
                  </div>
                ))}
              </div>
              {teamHealth.flagged_count > 0 && (
                <p className="mt-3 text-xs text-inksoft">
                  {teamHealth.flagged_count} member{teamHealth.flagged_count > 1 ? 's' : ''} currently show an elevated workload state or higher.
                </p>
              )}
              {teamHealth.dimensions && (
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  <div className="rounded-md border border-line bg-soft/40 p-3">
                    <p className="text-2xs uppercase tracking-[0.12em] text-inkfaint">Workload balance</p>
                    <p className="mt-1 font-display text-xl text-ink">{teamHealth.dimensions.workload_balance.healthy_pct ?? '—'}%</p>
                    <p className="text-2xs text-inkfaint">members healthy or watch</p>
                  </div>
                  <div className="rounded-md border border-line bg-soft/40 p-3">
                    <p className="text-2xs uppercase tracking-[0.12em] text-inkfaint">Rest adequacy</p>
                    <p className="mt-1 font-display text-xl text-ink">{teamHealth.dimensions.rest.healthy_pct ?? '—'}%</p>
                    <p className="text-2xs text-inkfaint">no short-rest or late-night</p>
                  </div>
                  <div className="rounded-md border border-line bg-soft/40 p-3">
                    <p className="text-2xs uppercase tracking-[0.12em] text-inkfaint">Attendance coverage</p>
                    <p className="mt-1 font-display text-xl text-ink">{teamHealth.dimensions.attendance.coverage_pct ?? '—'}%</p>
                    <p className="text-2xs text-inkfaint">{teamHealth.dimensions.attendance.active_members} active in window</p>
                  </div>
                </div>
              )}
              <button onClick={onRefresh} className="mt-3 rounded-md border border-line px-3 py-1.5 text-xs text-inksoft transition-colors hover:bg-soft">
                Refresh
              </button>
            </>
          )}
        </div>
      )}

      {teamWorkload && (
        <div className="px-5 py-4">
          <p className="eyebrow">Workload · discreet view</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {teamWorkload.distribution.map((d: any) => (
              <span key={d.state} className="rounded-full border border-line bg-soft/40 px-2.5 py-1 text-2xs text-inksoft">
                {d.state} · {d.count}
              </span>
            ))}
          </div>
          {teamWorkload.escalated.length > 0 && (
            <div className="mt-3 space-y-2">
              <p className="text-2xs uppercase tracking-[0.14em] text-inkfaint">Elevated (open escalation)</p>
              {teamWorkload.escalated.map((e: any) => (
                <div key={e.person_id} className="flex items-center justify-between gap-3 rounded-md border border-warn/40 bg-warnsoft/40 px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">{e.position}</p>
                    <p className="text-2xs text-inkfaint">Open since {new Date(e.escalation.first_recorded_at).toLocaleDateString()}</p>
                  </div>
                  <span className="shrink-0 text-2xs font-medium uppercase tracking-[0.12em] text-warn">{e.state}</span>
                </div>
              ))}
              <p className="text-2xs leading-relaxed text-inkfaint">
                Individuals are never called out publicly. This view is private to the department head; the person
                themselves sees only their own signals.
              </p>
            </div>
          )}
        </div>
      )}

      {scorecard && (
        <div className="px-5 py-4">
          <p className="eyebrow">Leadership environment scorecard</p>
          {scorecard.masked ? (
            <p className="mt-1 text-xs leading-relaxed text-inksoft">{scorecard.message}</p>
          ) : (
            <>
              <p className="mt-1 text-2xs text-inkfaint">
                {scorecard.scope_member_count} people in scope across {scorecard.groups_in_scope} group
                {scorecard.groups_in_scope > 1 ? 's' : ''}.
                {scorecard.masked_groups.length > 0 && ` ${scorecard.masked_groups.length} smaller group(s) suppressed.`}
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                <div className="rounded-md border border-line bg-soft/40 p-3">
                  <p className="text-2xs uppercase tracking-[0.12em] text-inkfaint">Workload balance</p>
                  <p className="mt-1 font-display text-xl text-ink">{scorecard.dimensions.workload_balance.healthy_pct ?? '—'}%</p>
                  <p className="text-2xs text-inkfaint">healthy or watch</p>
                </div>
                <div className="rounded-md border border-line bg-soft/40 p-3">
                  <p className="text-2xs uppercase tracking-[0.12em] text-inkfaint">Rest adequacy</p>
                  <p className="mt-1 font-display text-xl text-ink">{scorecard.dimensions.rest.healthy_pct ?? '—'}%</p>
                  <p className="text-2xs text-inkfaint">no short-rest / late-night</p>
                </div>
                <div className="rounded-md border border-line bg-soft/40 p-3">
                  <p className="text-2xs uppercase tracking-[0.12em] text-inkfaint">Attendance coverage</p>
                  <p className="mt-1 font-display text-xl text-ink">{scorecard.dimensions.attendance.coverage_pct ?? '—'}%</p>
                  <p className="text-2xs text-inkfaint">{scorecard.dimensions.attendance.active_members} active</p>
                </div>
              </div>
              {scorecard.index && (
                <div className="mt-4 rounded-md border border-line bg-soft/40 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-2xs uppercase tracking-[0.14em] text-inkfaint">Team health index · composite</p>
                    <span className={clsx('rounded-full px-2.5 py-0.5 text-2xs font-medium uppercase tracking-[0.12em]', scorecard.index.band === 'HEALTHY' && 'bg-oksoft text-ok', scorecard.index.band === 'STABLE' && 'bg-brandsoft text-branddeep', scorecard.index.band === 'STRAINED' && 'bg-warnsoft text-warn', scorecard.index.band === 'STRESSED' && 'bg-dangersoft text-danger')}>
                      {scorecard.index.band}
                    </span>
                  </div>
                  <p className="mt-1 font-display text-3xl text-ink">{scorecard.index.index}<span className="text-base text-inkfaint">/100</span></p>
                  <div className="mt-3 space-y-2.5">
                    {scorecard.index.components.map((c: any) => (
                      <div key={c.key}>
                        <div className="flex items-baseline justify-between gap-2">
                          <p className="text-2xs font-medium uppercase tracking-[0.12em] text-inksoft">{c.label} <span className="text-inkfaint">· weight {c.weight}%</span></p>
                          <p className="text-2xs text-inksoft">{c.score}/100</p>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line/60">
                          <div className={clsx('h-full rounded-full', c.score >= 80 ? 'bg-ok' : c.score >= 60 ? 'bg-brand' : c.score >= 40 ? 'bg-warn' : 'bg-danger')} style={{ width: `${c.score}%` }} />
                        </div>
                        <p className="mt-0.5 text-2xs text-inkfaint">{c.formula} — {Object.entries(c.inputs).map(([k, v]) => `${k} ${v}`).join(' · ')}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {scorecard.leader && (
                <p className="mt-3 text-xs text-inksoft">
                  Your own workload state in this window: <span className="font-medium text-ink">{scorecard.leader.state}</span>
                  {scorecard.leader.score > 0 && ` (score ${scorecard.leader.score})`}.
                </p>
              )}
              <p className="mt-2 text-2xs text-inkfaint">{scorecard.note}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PosDetail({ pos, dept, holder, reports, onFocus }: {
  pos: Pos; dept: Dept | null; holder: Person | null; reports: Person[];
  onFocus: (id: string) => void;
}) {
  return (
    <div className="divide-y divide-line">
      <div className="px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-soft">
            <Briefcase className="h-4 w-4 text-inkfaint" strokeWidth={2} />
          </div>
          <div>
            <p className="font-display text-lg font-medium text-ink">{pos.title}</p>
            <p className="text-xs text-inksoft">
              {dept?.name ?? 'No department'}
              {pos.head_of_department_id ? ' · Department lead role' : ''}
            </p>
          </div>
        </div>
        {holder && (
          <button onClick={() => onFocus(holder.id)} className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-line bg-soft/50 px-3 py-1 text-xs text-ink transition-colors hover:border-brand">
            <Users className="h-3 w-3 text-inkfaint" strokeWidth={2} /> {holder.name}
          </button>
        )}
        {!holder && <p className="mt-3 text-xs text-inksoft">This role is currently vacant.</p>}
      </div>
      <div className="px-5 py-4">
        <p className="eyebrow">Reports into this role</p>
        {reports.length === 0 ? (
          <p className="mt-1 text-sm text-inkfaint">None recorded.</p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            {reports.map((r) => (
              <button key={r.id} onClick={() => onFocus(r.id)} className="rounded-full border border-line px-3 py-1 text-xs text-ink transition-colors hover:border-inkfaint">{r.name}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}