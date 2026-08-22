import { useRef, useState, useCallback } from 'react';
import { ChevronRight, ChevronDown, Crown, Briefcase } from 'lucide-react';
import { api } from '../../api/client';

export interface Dept {
  id: string;
  name: string;
  parent_department_id: string | null;
  head_person_id: string | null;
  head_name: string | null;
  head_position_id: string | null;
}

export interface Pos {
  id: string;
  title: string;
  department_id: string;
  head_of_department_id: string | null;
  parent_position_id: string | null;
}

export interface Person {
  id: string;
  name: string;
  position_id: string | null;
  department_id: string | null;
  grade: string | null;
  skills: string[];
  projects: string[];
}

export interface ExplorerData {
  departments: Dept[];
  positions: Pos[];
  people: Person[];
}

export async function fetchExplorer(): Promise<ExplorerData> {
  const res = await api.get('/organization/explorer');
  return res.data;
}

// ---------- chart geometry: strict column grid ----------

interface LayoutBox {
  id: string;
  kind: 'dept' | 'pos' | 'person';
  col: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OrgChartLayout {
  boxes: LayoutBox[];
  columns: { dept: Dept; x: number; y: number; w: number; h: number }[];
  width: number;
  height: number;
  positionsByDept: Map<string, Pos[]>;
  peopleByPosition: Map<string, Person[]>;
}

const COL_W = 236;
const COL_GAP = 30;
const PAD = 26;
const HEADER_H = 64;
const POS_H = 52;
const CHIP_H = 36;
const GAP = 10;

function deptTreeOrder(depts: Dept[]): Dept[] {
  const byId = new Map(depts.map((d) => [d.id, d]));
  const childrenOf = new Map<string, Dept[]>();
  for (const d of depts) {
    if (d.parent_department_id && byId.has(d.parent_department_id)) {
      const arr = childrenOf.get(d.parent_department_id) ?? [];
      arr.push(d);
      childrenOf.set(d.parent_department_id, arr);
    }
  }
  const roots = depts.filter((d) => !d.parent_department_id || !byId.has(d.parent_department_id));
  const out: Dept[] = [];
  const walk = (d: Dept) => {
    out.push(d);
    for (const c of childrenOf.get(d.id) ?? []) walk(c);
  };
  for (const r of roots) walk(r);
  for (const d of depts) if (!out.includes(d)) out.push(d);
  return out;
}

export function computeLayout(data: ExplorerData, collapsed: Set<string>): OrgChartLayout {
  const positionsByDept = new Map<string, Pos[]>();
  for (const p of data.positions) {
    const arr = positionsByDept.get(p.department_id) ?? [];
    arr.push(p);
    positionsByDept.set(p.department_id, arr);
  }
  const peopleByPosition = new Map<string, Person[]>();
  for (const p of data.people) {
    if (!p.position_id) continue;
    const arr = peopleByPosition.get(p.position_id) ?? [];
    arr.push(p);
    peopleByPosition.set(p.position_id, arr);
  }

  const ordered = deptTreeOrder(data.departments);
  const boxes: LayoutBox[] = [];
  const columns: OrgChartLayout['columns'] = [];
  const COLS_PER_ROW = Math.max(1, Math.min(6, Math.floor(1400 / (COL_W + COL_GAP))));
  let maxRowHeight = 0;

  ordered.forEach((d, i) => {
    const rowIndex = Math.floor(i / COLS_PER_ROW);
    const colInRow = i % COLS_PER_ROW;
    const colX = PAD + colInRow * (COL_W + COL_GAP);
    const colY = PAD + rowIndex * (maxRowHeight + 56);
    const collapsedDept = collapsed.has(d.id);

    let cursor = colY;
    boxes.push({ id: d.id, kind: 'dept', col: i, x: colX, y: cursor, w: COL_W, h: HEADER_H });
    cursor += HEADER_H + GAP;

    if (!collapsedDept) {
      for (const p of positionsByDept.get(d.id) ?? []) {
        boxes.push({ id: p.id, kind: 'pos', col: i, x: colX, y: cursor, w: COL_W, h: POS_H });
        cursor += POS_H + GAP;
        const people = peopleByPosition.get(p.id) ?? [];
        if (people.length > 0) {
          const perRow = people.length > 3 ? 2 : people.length > 1 ? 2 : 1;
          const rows = Math.ceil(people.length / perRow);
          const chipW = (COL_W - GAP) / Math.max(1, perRow);
          people.forEach((person, pi) => {
            const pr = Math.floor(pi / perRow);
            const pc = pi % perRow;
            boxes.push({
              id: person.id,
              kind: 'person',
              col: i,
              x: colX + pc * (chipW + GAP),
              y: cursor + pr * (CHIP_H + GAP),
              w: chipW,
              h: CHIP_H,
            });
          });
          cursor += rows * (CHIP_H + GAP) + GAP;
        }
      }
    }

    const colBottom = Math.max(cursor, colY + HEADER_H);
    columns.push({ dept: d, x: colX, y: colY, w: COL_W, h: colBottom - colY });
    maxRowHeight = Math.max(maxRowHeight, colBottom - colY);
  });

  const rowsUsed = Math.ceil(ordered.length / COLS_PER_ROW);
  return {
    boxes,
    columns,
    width: Math.max(PAD * 2 + Math.min(ordered.length, COLS_PER_ROW) * (COL_W + COL_GAP) - COL_GAP, 640),
    height: PAD + rowsUsed * (maxRowHeight + 56),
    positionsByDept,
    peopleByPosition,
  };
}

// ---------- the chart ----------

interface ChartProps {
  data: ExplorerData;
  collapsed: Set<string>;
  onToggleDept: (id: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  query: string;
  focusChain: Set<string>;
}

export function OrgChart({ data, collapsed, onToggleDept, selectedId, onSelect, query, focusChain }: ChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ x: 24, y: 12, scale: 1 });
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const layout = useMemo2(data, collapsed);
  const q = query.trim().toLowerCase();

  const matchingPeople = new Set<string>();
  const matchingPositions = new Set<string>();
  const matchingDepts = new Set<string>();
  if (q) {
    for (const p of data.people) {
      const hay = `${p.name} ${p.skills.join(' ')} ${p.projects.join(' ')} ${p.grade ?? ''}`.toLowerCase();
      if (hay.includes(q)) matchingPeople.add(p.id);
    }
    for (const pos of data.positions) {
      if (pos.title.toLowerCase().includes(q)) matchingPositions.add(pos.id);
    }
    for (const d of data.departments) {
      if (d.name.toLowerCase().includes(q)) matchingDepts.add(d.id);
    }
  }
  const hasFilter = q.length > 0;

  const onWheel = useCallback((e: React.WheelEvent) => {
    const factor = e.deltaY > 0 ? 0.92 : 1.08;
    setView((v) => ({ ...v, scale: Math.min(1.5, Math.max(0.55, v.scale * factor)) }));
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX - view.x, y: e.clientY - view.y, moved: false };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current.moved = true;
    setView((v) => ({ ...v, x: e.clientX - drag.current!.x, y: e.clientY - drag.current!.y }));
  };
  const onPointerUp = () => (drag.current = null);

  const deptById = new Map(data.departments.map((d) => [d.id, d]));
  const posById = new Map(data.positions.map((p) => [p.id, p]));
  const peopleByPos = layout.peopleByPosition;
  const anySelection = selectedId != null;

  // Primary edges: dept -> child dept (strong). Secondary: pos -> person (fine).
  const primaryEdges: { from: LayoutBox; to: LayoutBox }[] = [];
  const secondaryEdges: { from: LayoutBox; to: LayoutBox }[] = [];
  for (const d of data.departments) {
    if (!d.parent_department_id) continue;
    const from = layout.boxes.find((b) => b.id === d.parent_department_id && b.kind === 'dept');
    const to = layout.boxes.find((b) => b.id === d.id && b.kind === 'dept');
    if (from && to) primaryEdges.push({ from, to });
  }
  for (const pos of data.positions) {
    if (collapsed.has(pos.department_id)) continue;
    const from = layout.boxes.find((b) => b.id === pos.id && b.kind === 'pos');
    for (const person of peopleByPos.get(pos.id) ?? []) {
      const to = layout.boxes.find((b) => b.id === person.id && b.kind === 'person');
      if (from && to) secondaryEdges.push({ from, to });
    }
  }

  const nodeDimmed = (b: LayoutBox): boolean => {
    if (!hasFilter && !anySelection) return false;
    if (hasFilter) {
      if (b.kind === 'dept') {
        const positions = layout.positionsByDept.get(b.id) ?? [];
        return !matchingDepts.has(b.id) && positions.every((p) => !matchingPositions.has(p.id)) &&
          !(positions.some((p) => (peopleByPos.get(p.id) ?? []).some((pp) => matchingPeople.has(pp.id))));
      }
      if (b.kind === 'pos') {
        return !matchingPositions.has(b.id) && !(peopleByPos.get(b.id) ?? []).some((pp) => matchingPeople.has(pp.id));
      }
      return !matchingPeople.has(b.id);
    }
    if (b.id === selectedId) return false;
    if (b.kind === 'dept') {
      return !focusChain.has(b.id) && !(layout.positionsByDept.get(b.id) ?? []).some((p) => focusChain.has(p.id));
    }
    return !focusChain.has(b.id);
  };

  const renderBox = (b: LayoutBox) => {
    const dimmed = nodeDimmed(b);
    if (b.kind === 'dept') {
      const d = deptById.get(b.id)!;
      const positions = layout.positionsByDept.get(b.id) ?? [];
      const people = data.people.filter((p) => p.department_id === b.id);
      const isCollapsed = collapsed.has(b.id);
      const isFocused = focusChain.has(b.id) || matchingDepts.has(b.id);
      return (
        <g key={b.id} transform={`translate(${b.x} ${b.y})`} onClick={(e) => { e.stopPropagation(); if (!drag.current?.moved) onToggleDept(b.id); }} className="group cursor-pointer">
          <rect width={b.w} height={b.h} rx={12} fill={isFocused ? '#FBF3E8' : '#FFFDF9'} stroke={isFocused ? '#FF5A1F' : '#E7DED2'} strokeWidth={isFocused ? 1.6 : 1} className="transition-opacity group-hover:opacity-90" opacity={dimmed ? 0.35 : 1} />
          <rect x={1} y={1} width={b.w - 2} height={3} rx={1.5} fill="#FF5A1F" opacity={isFocused ? 1 : 0.85} />
          <g transform="translate(14 22)">
            {isCollapsed ? <ChevronRight className="h-4 w-4 text-inkfaint" strokeWidth={2} /> : <ChevronDown className="h-4 w-4 text-inkfaint" strokeWidth={2} />}
          </g>
          <text x={36} y={26} fontSize={15} fontWeight={650} fill="#171411" style={{ fontFamily: 'Fraunces, serif' }}>{d.name}</text>
          <text x={36} y={44} fontSize={10.5} fill="#8C857C" style={{ fontFamily: 'Inter, sans-serif' }}>
            {positions.length} {positions.length === 1 ? 'role' : 'roles'} · {people.length} {people.length === 1 ? 'member' : 'members'}
          </text>
          {d.head_name && (
            <g transform={`translate(14 ${b.h - 26})`}>
              <rect width={b.w - 28} height={20} rx={5} fill="#F7F3EC" />
              <Crown className="h-2.5 w-2.5 text-brand" strokeWidth={2} style={{ transform: 'translate(8px 4.5px)' }} />
              <text x={20} y={13.5} fontSize={10} fontWeight={600} fill="#171411" style={{ fontFamily: 'Inter, sans-serif' }}>{d.head_name}</text>
              <text x={Math.min(20 + d.head_name.length * 5.6, b.w - 52)} y={13.5} fontSize={9} fill="#8C857C" style={{ fontFamily: 'Inter, sans-serif' }}>leads</text>
            </g>
          )}
        </g>
      );
    }

    if (b.kind === 'pos') {
      const p = posById.get(b.id)!;
      const holder = (peopleByPos.get(p.id) ?? [])[0];
      const isHead = Boolean(p.head_of_department_id);
      const isFocused = focusChain.has(b.id) || matchingPositions.has(b.id);
      const selected = b.id === selectedId;
      return (
        <g key={b.id} transform={`translate(${b.x} ${b.y})`} onClick={(e) => { e.stopPropagation(); if (!drag.current?.moved) onSelect(p.id); }} className="group cursor-pointer">
          <rect width={b.w} height={b.h} rx={9} fill={isFocused ? '#FDF1E3' : '#FFFDF9'} stroke={selected ? '#FF5A1F' : isFocused ? '#FF5A1F' : isHead ? '#C96A2B' : '#E7DED2'} strokeWidth={selected ? 2 : isFocused ? 1.6 : isHead ? 1.4 : 1} className="transition-opacity group-hover:opacity-90" opacity={dimmed ? 0.3 : 1} />
          <rect width={4} height={b.h} rx={2} fill={isHead ? '#FF5A1F' : '#DCD4C8'} />
          <text x={16} y={21} fontSize={12} fontWeight={600} fill="#171411" style={{ fontFamily: 'Inter, sans-serif' }}>{p.title.length > 26 ? p.title.slice(0, 25) + '…' : p.title}</text>
          <text x={16} y={38} fontSize={10} fill="#8C857C" style={{ fontFamily: 'Inter, sans-serif' }}>
            {isHead ? 'Department lead' : holder ? `Grade ${holder.grade ?? '—'}` : 'Open position'}
          </text>
          {isHead && <Crown className="h-3 w-3 text-brand" strokeWidth={2} style={{ transform: `translate(${b.w - 20}px 8px)` }} />}
        </g>
      );
    }

    const person = data.people.find((pp) => pp.id === b.id)!;
    const pos = person.position_id ? posById.get(person.position_id) : null;
    const selected = b.id === selectedId;
    const isFocused = focusChain.has(b.id);
    const label = person.name.length > 18 ? person.name.slice(0, 17) + '…' : person.name;
    return (
      <g key={b.id} transform={`translate(${b.x} ${b.y})`} onClick={(e) => { e.stopPropagation(); if (!drag.current?.moved) onSelect(b.id); }} className="group cursor-pointer">
        <rect width={b.w} height={b.h} rx={7} fill={selected || isFocused ? '#171411' : '#FFFDF9'} stroke={selected || isFocused ? '#171411' : '#E7DED2'} strokeWidth={selected ? 1.8 : 1.1} className="transition-opacity group-hover:opacity-90" opacity={dimmed ? 0.2 : 1} />
        <circle cx={12} cy={18} r={7} fill={selected || isFocused ? '#3A342C' : '#F1ECE3'} />
        <text x={12} y={21} fontSize={9} fontWeight={600} textAnchor="middle" fill={selected || isFocused ? '#FFB89A' : '#8C857C'} style={{ fontFamily: 'Inter, sans-serif' }}>
          {label[0]?.toUpperCase() ?? '?'}
        </text>
        <text x={24} y={16.5} fontSize={10.5} fontWeight={600} fill={selected || isFocused ? '#FFFDF9' : '#171411'} style={{ fontFamily: 'Inter, sans-serif' }}>{label}</text>
        <text x={24} y={29.5} fontSize={9} fill={selected || isFocused ? '#C9BFAE' : '#8C857C'} style={{ fontFamily: 'Inter, sans-serif' }}>
          {pos?.title ?? 'Unassigned'}{person.grade ? ` · ${person.grade}` : ''}
        </text>
        {person.skills.length > 0 && (
          <g transform={`translate(${b.w - 20} 8)`}>
            <circle r={9} fill="#F7F3EC" />
            <Briefcase className="h-2.5 w-2.5 text-inkfaint" strokeWidth={2} style={{ transform: 'translate(-5px -5px)' }} />
            <text x={2} y={13} fontSize={8} fontWeight={600} fill="#8C857C" textAnchor="middle" style={{ fontFamily: 'Inter, sans-serif' }}>{person.skills.length}</text>
          </g>
        )}
      </g>
    );
  };

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        className="w-full select-none cursor-grab active:cursor-grabbing"
        style={{ height: Math.min(620, layout.height + 60) }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        role="img"
        aria-label="Organization chart — departments, roles and people"
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          {primaryEdges.map((e) => {
            const x1 = e.from.x + e.from.w / 2;
            const y1 = e.from.y + e.from.h;
            const x2 = e.to.x + e.to.w / 2;
            const y2 = e.to.y;
            const midY = (y1 + y2) / 2;
            const strokeDim = hasFilter || anySelection ? 0.35 : 1;
            return (
              <path key={`pe-${e.to.id}`} d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`} fill="none" stroke="#C96A2B" strokeWidth={1.6} strokeDasharray="1 0" opacity={strokeDim} />
            );
          })}
          {secondaryEdges.map((e) => (
            <path key={`se-${e.from.id}-${e.to.id}`} d={`M ${e.from.x + 4} ${e.from.y + e.from.h} L ${e.from.x + 4} ${e.to.y + e.to.h / 2}`} fill="none" stroke="#DCD4C8" strokeWidth={1.1} opacity={hasFilter || anySelection ? 0.4 : 0.9} />
          ))}
          {layout.boxes.map(renderBox)}
        </g>
      </svg>
      <div className="pointer-events-none absolute bottom-2 right-3 rounded-full border border-line bg-surface/90 px-2.5 py-1 text-2xs text-inkfaint">
        {hasFilter ? `Showing matches in ${matchingPeople.size + matchingPositions.size + matchingDepts.size} nodes` : 'Scroll to zoom · drag to pan · click a card'}
      </div>
    </div>
  );
}

function useMemo2(data: ExplorerData, collapsed: Set<string>): OrgChartLayout {
  const ref = useRef<{ key: string; layout: OrgChartLayout } | null>(null);
  const key = collapsed.size + '|' + data.departments.length + '|' + data.positions.length + '|' + data.people.length;
  if (!ref.current || ref.current.key !== key) {
    ref.current = { key, layout: computeLayout(data, collapsed) };
  }
  return ref.current.layout;
}

export function OrgExplorerLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-2xs text-inkfaint">
      <span className="inline-flex items-center gap-1.5">
        <span className="h-3 w-3 rounded-sm border border-line bg-surface shadow-sm" /> Department
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Crown className="h-3 w-3 text-brand" strokeWidth={2} /> Department lead
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-sm border border-line bg-surface" /> Role
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-sm bg-ink" /> Person
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-0.5 w-4 rounded-full bg-[#C96A2B]" /> Department relation
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-0.5 w-4 rounded-full bg-line" /> Role → member
      </span>
      <span className="ml-auto hidden sm:inline">Selection dims the rest of the structure.</span>
    </div>
  );
}

export function searchPeople(data: ExplorerData, q: string): Person[] {
  const query = q.trim().toLowerCase();
  if (!query) return data.people;
  return data.people.filter((p) =>
    `${p.name} ${p.skills.join(' ')} ${p.projects.join(' ')} ${p.grade ?? ''}`.toLowerCase().includes(query)
  );
}

export function managerChain(data: ExplorerData, personId: string): { label: string; personId: string | null }[] {
  const person = data.people.find((p) => p.id === personId);
  if (!person || !person.position_id) return [];
  const posById = new Map(data.positions.map((p) => [p.id, p]));
  const chain: { label: string; personId: string | null }[] = [];
  let curPos = posById.get(person.position_id) ?? null;
  let guard = 0;
  while (curPos && guard++ < 10) {
    const holder = data.people.find((p) => p.position_id === curPos!.id && p.id !== personId);
    if (holder) chain.push({ label: `${holder.name} — ${curPos.title}`, personId: holder.id });
    else if (curPos.head_of_department_id) {
      const head = data.people.find((p) => p.id === curPos!.head_of_department_id);
      if (head) chain.push({ label: `${head.name} — ${curPos.title} (lead)`, personId: head.id });
    }
    curPos = curPos.parent_position_id ? (posById.get(curPos.parent_position_id) ?? null) : null;
  }
  return chain;
}

export function directReports(data: ExplorerData, personId: string): Person[] {
  const person = data.people.find((p) => p.id === personId);
  if (!person || !person.position_id) return [];
  const reports: Person[] = [];
  for (const p of data.people) {
    if (p.id === personId) continue;
    const pos = data.positions.find((x) => x.id === p.position_id);
    if (pos?.parent_position_id === person.position_id) reports.push(p);
  }
  return reports;
}