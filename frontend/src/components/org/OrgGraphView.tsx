import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Plus, Minus, Maximize2, Minimize2, Search, Crown,
  ChevronDown, ChevronRight, Network,
} from 'lucide-react';
import clsx from 'clsx';
import type { ExplorerData, Dept, Pos, Person } from './OrgExplorer';
import { searchOrgGraph, type GNode, type OrgGraphLayout, type OrgSearchResult } from '../../lib/orgGraph';

const MIN_SCALE = 0.15;
const MAX_SCALE = 1.6;

interface ViewState { x: number; y: number; scale: number }

interface Props {
  data: ExplorerData;
  layout: OrgGraphLayout;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  focusRequest: { id: string; ts: number } | null;
}

function useReducedMotion(): boolean {
  return useMemo(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
}

export function OrgGraphView({ data, layout, collapsed, onToggle, selectedId, onSelect, fullscreen, onToggleFullscreen, focusRequest }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ViewState>({ x: 24, y: 12, scale: 1 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<OrgSearchResult[]>([]);
  const [drag, setDrag] = useState<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const anim = useRef<number | null>(null);
  const reduced = useReducedMotion();

  // measure container
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // fit on first layout / data change
  const fitKey = layout.width + 'x' + layout.height;
  useEffect(() => {
    if (size.w === 0 || size.h === 0) return;
    const pad = 40;
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min((size.w - pad) / layout.width, (size.h - pad) / layout.height)));
    setView({ x: (size.w - layout.width * scale) / 2, y: (size.h - layout.height * scale) / 2, scale });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, size.w, size.h]);

  // search results (semantic: name, role, department, project, skill)
  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    const t = window.setTimeout(() => setResults(searchOrgGraph(data, query)), 160);
    return () => window.clearTimeout(t);
  }, [query, data]);

  const flyTo = useCallback((target: { x: number; y: number; w: number; h: number }) => {
    if (size.w === 0) return;
    const scale = Math.min(1.1, Math.max(0.5, Math.min((size.w - 120) / target.w, (size.h - 120) / target.h, 1)));
    const tx = (size.w - target.w * scale) / 2 - target.x * scale;
    const ty = (size.h - target.h * scale) / 2 - target.y * scale;
    const from = viewRef.current;
    const to = { x: tx, y: ty, scale };
    if (reduced) { setView(to); return; }
    if (anim.current) cancelAnimationFrame(anim.current);
    const start = performance.now();
    const dur = 380;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      setView({
        x: from.x + (to.x - from.x) * e,
        y: from.y + (to.y - from.y) * e,
        scale: from.scale + (to.scale - from.scale) * e,
      });
      if (t < 1) anim.current = requestAnimationFrame(step);
      else anim.current = null;
    };
    anim.current = requestAnimationFrame(step);
  }, [size, reduced]);

  const viewRef = useRef(view);
  viewRef.current = view;

  const pickSearchResult = (r: OrgSearchResult) => {
    onSelect(r.id);
    setQuery('');
    setResults([]);
    // expand ancestors so the target is visible
    if (r.type === 'person') {
      const person = data.people.find((p) => p.id === r.id);
      if (person?.position_id) {
        const pos = data.positions.find((p) => p.id === person.position_id);
        if (pos) {
          if (collapsed.has(pos.id)) onToggle(pos.id);
          if (collapsed.has(pos.department_id)) onToggle(pos.department_id);
        }
      }
    } else if (r.type === 'position') {
      const pos = data.positions.find((p) => p.id === r.id);
      if (pos && collapsed.has(pos.department_id)) onToggle(pos.department_id);
    }
    const node = layout.byId.get(r.id);
    if (node) flyTo(node);
    else window.setTimeout(() => { const n = layoutRef.current.byId.get(r.id); if (n) flyTo(n); }, 260);
  };

  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // external focus requests (e.g. search chips above the chart)
  useEffect(() => {
    if (!focusRequest) return;
    onSelect(focusRequest.id);
    if (focusRequest.id !== 'org-root') {
      const node = layout.byId.get(focusRequest.id);
      if (node) {
        if (node.type === 'person' || node.type === 'position') {
          const pos = data.positions.find((p) => p.id === (node.type === 'person' ? (node.data as Person)?.position_id : node.id));
          if (pos) {
            if (collapsed.has(pos.id)) onToggle(pos.id);
            if (collapsed.has(pos.department_id)) onToggle(pos.department_id);
          }
        }
        flyTo(node);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  // Escape exits fullscreen
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onToggleFullscreen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen, onToggleFullscreen]);

  const fitAll = useCallback(() => {
    if (size.w === 0) return;
    const pad = 40;
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min((size.w - pad) / layout.width, (size.h - pad) / layout.height)));
    const from = viewRef.current;
    const to = { x: (size.w - layout.width * scale) / 2, y: (size.h - layout.height * scale) / 2, scale };
    if (reduced) { setView(to); return; }
    if (anim.current) cancelAnimationFrame(anim.current);
    const start = performance.now();
    const dur = 320;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      setView({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, scale: from.scale + (to.scale - from.scale) * e });
      if (t < 1) anim.current = requestAnimationFrame(step);
      else anim.current = null;
    };
    anim.current = requestAnimationFrame(step);
  }, [size, layout, reduced]);

  const zoomBy = useCallback((factor: number, cx?: number, cy?: number) => {
    const el = svgRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = cx ?? rect.width / 2;
    const py = cy ?? rect.height / 2;
    setView((v) => {
      const ns = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
      const wx = (px - v.x) / v.scale;
      const wy = (py - v.y) / v.scale;
      return { x: px - wx * ns, y: py - wy * ns, scale: ns };
    });
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    zoomBy(e.deltaY > 0 ? 0.88 : 1.14, e.clientX - rect.left, e.clientY - rect.top);
  }, [zoomBy]);

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as Element).closest('[data-node]')) return;
    setDrag({ sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false });
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    setDrag((d) => {
      if (!d) return d;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (!d.moved && Math.hypot(dx, dy) > 4) d.moved = true;
      setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
      return d;
    });
  };
  const onPointerUp = () => setDrag(null);

  // ---------- focus / dimming
  const dim = useMemo(() => {
    const active = selectedId != null;
    const keep = new Set<string>(['org-root']);
    const path: string[] = [];
    if (!active) return { active: false, keep, path };
    keep.add(selectedId!);
    let cur: GNode | undefined = layout.byId.get(selectedId!);
    while (cur) {
      keep.add(cur.id);
      path.unshift(cur.id);
      if (cur.type === 'dept') {
        // whole cluster stays visible
        for (const n of layout.nodes) if (n.deptId === cur.id) keep.add(n.id);
        break;
      }
      if (cur.type === 'position') {
        for (const n of layout.nodes) if (n.id !== cur.id && n.data && (n.data as Person).position_id === cur.id) keep.add(n.id);
      }
      cur = cur.deptId ? layout.byId.get(cur.deptId) : undefined;
    }
    return { active, keep, path };
  }, [selectedId, layout]);

  const nodeDimmed = (n: GNode) => dim.active && !dim.keep.has(n.id);
  const edgeVisible = (e: { source: string; target: string }) => !dim.active || (dim.keep.has(e.source) && dim.keep.has(e.target));

  // ---------- minimap
  const mm = useMemo(() => {
    const MW = 168, MH = 108;
    if (layout.width <= 0 || layout.height <= 0) return null;
    const s = Math.min(MW / layout.width, MH / layout.height);
    const vw = size.w / view.scale, vh = size.h / view.scale;
    const vx = -view.x / view.scale, vy = -view.y / view.scale;
    return {
      s,
      w: layout.width * s, h: layout.height * s,
      view: { x: vx * s, y: vy * s, w: vw * s, h: vh * s },
    };
  }, [layout, size, view]);

  const jumpMinimap = (e: React.MouseEvent) => {
    if (!mm) return;
    const rect = (e.currentTarget as Element).getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width * mm.w;
    const py = (e.clientY - rect.top) / rect.height * mm.h;
    const wx = px / mm.s;
    const wy = py / mm.s;
    setView({ scale: view.scale, x: size.w / 2 - wx * view.scale, y: size.h / 2 - wy * view.scale });
  };

  const stats = useMemo(() => {
    const people = data.people;
    const open = data.positions.filter((p) => !people.some((pp) => pp.position_id === p.id));
    return { depts: data.departments.length, pos: data.positions.length, people: people.length, open: open.length };
  }, [data]);

  const content = (
    <div ref={boxRef} className={clsx('relative overflow-hidden rounded-xl border border-line bg-surface', fullscreen ? 'h-full w-full rounded-none border-0' : 'h-[calc(100vh-18rem)] min-h-[30rem]')}>
      {layout.nodes.length === 0 ? (
        <div className="empty-state">
          <p className="text-sm font-medium text-ink">Nothing to show</p>
          <p className="mt-1 text-xs text-inkfaint">Every department is collapsed.</p>
        </div>
      ) : (
        <svg
          ref={svgRef}
          className="h-full w-full cursor-grab touch-none select-none active:cursor-grabbing"
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          role="img"
          aria-label="Organization graph — departments, positions and people"
        >
          <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
            {/* cluster containers */}
            {layout.clusters.map((c) => (
              <g key={'cl:' + c.deptId}>
                <rect
                  x={c.x} y={c.y} width={c.w} height={c.h} rx={18}
                  fill="#FBF6ED"
                  stroke="#E8DECD"
                  strokeWidth={1.2}
                  className="transition-opacity duration-200"
                  opacity={dim.active && !dim.keep.has(c.deptId) ? 0.16 : 1}
                />
              </g>
            ))}

            {/* edges */}
            {layout.edges.map((e) => {
              if (!edgeVisible(e) || e.points.length < 2) return null;
              const d = e.points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
              const isStructure = e.kind === 'structure';
              return (
                <path
                  key={e.id}
                  d={d}
                  fill="none"
                  stroke={isStructure ? '#C96A2B' : '#D8CFC0'}
                  strokeWidth={isStructure ? 2 : 1.1}
                  strokeLinejoin="round"
                  opacity={dim.active ? 0.5 : isStructure ? 0.85 : 0.65}
                  className="transition-opacity duration-200"
                />
              );
            })}

            {/* nodes */}
            {layout.nodes.map((n) => (
              <GraphNode
                key={n.id}
                node={n}
                data={data}
                dimmed={nodeDimmed(n)}
                selected={selectedId === n.id}
                collapsed={collapsed.has(n.id)}
                collapsible={collapsible(n, data)}
                onSelect={onSelect}
                onToggle={onToggle}
                dragMoved={() => drag?.moved ?? false}
              />
            ))}
          </g>
        </svg>
      )}

      {/* canvas toolbar */}
      <div className="absolute right-3 top-3 flex flex-col gap-1.5 rounded-lg border border-line bg-surface/95 p-1 shadow-sm" role="group" aria-label="Graph controls">
        <button onClick={() => zoomBy(1.25)} className="flex h-9 w-9 items-center justify-center rounded-md text-inksoft transition-colors hover:bg-soft hover:text-ink" aria-label="Zoom in"><Plus className="h-4 w-4" strokeWidth={2} /></button>
        <button onClick={() => zoomBy(0.8)} className="flex h-9 w-9 items-center justify-center rounded-md text-inksoft transition-colors hover:bg-soft hover:text-ink" aria-label="Zoom out"><Minus className="h-4 w-4" strokeWidth={2} /></button>
        <button onClick={fitAll} className="flex h-9 w-9 items-center justify-center rounded-md text-inksoft transition-colors hover:bg-soft hover:text-ink" aria-label="Fit graph"><Maximize2 className="h-3.5 w-3.5" strokeWidth={2} /></button>
        <button onClick={onToggleFullscreen} className="flex h-9 w-9 items-center justify-center rounded-md text-inksoft transition-colors hover:bg-soft hover:text-ink" aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen graph'}>
          {fullscreen ? <Minimize2 className="h-3.5 w-3.5" strokeWidth={2} /> : <Maximize2 className="h-3.5 w-3.5" strokeWidth={2} />}
        </button>
      </div>

      {/* search */}
      <div className="absolute left-3 top-3 w-64">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-inkfaint" strokeWidth={2} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search people, roles, departments…"
            className="w-full rounded-lg border border-line bg-surface/95 py-2.5 pl-9 pr-3 text-xs text-ink shadow-sm outline-none transition-colors focus:border-inkfaint"
            aria-label="Search the organization graph"
          />
        </div>
        {results.length > 0 && (
          <div className="mt-1 overflow-hidden rounded-lg border border-line bg-surface shadow-float">
            {results.map((r) => (
              <button
                key={r.id}
                onClick={() => pickSearchResult(r)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-ink transition-colors hover:bg-soft"
              >
                <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', r.type === 'dept' ? 'bg-brand' : r.type === 'position' ? 'bg-[#C96A2B]' : 'bg-ink')} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{r.label}</span>
                  <span className="block truncate text-2xs text-inkfaint">{r.detail}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* minimap */}
      {mm && (
        <button
          onClick={jumpMinimap}
          className="absolute bottom-3 right-3 hidden overflow-hidden rounded-lg border border-line bg-surface/95 p-1.5 shadow-sm md:block"
          aria-label="Minimap — click to jump"
        >
          <svg width={mm.w + 12} height={mm.h + 12} className="block">
            {layout.clusters.map((c) => (
              <rect key={c.deptId} x={c.x * mm.s + 6} y={c.y * mm.s + 6} width={c.w * mm.s} height={c.h * mm.s} rx={2} fill="#F1E8D9" stroke="#E2D5BF" strokeWidth={0.5} />
            ))}
            <rect
              x={mm.view.x + 6} y={mm.view.y + 6} width={mm.view.w} height={mm.view.h}
              fill="rgba(23,20,17,0.06)" stroke="#C96A2B" strokeWidth={1}
            />
          </svg>
        </button>
      )}

      <div className="pointer-events-none absolute bottom-3 left-3 rounded-full border border-line bg-surface/90 px-2.5 py-1 text-2xs text-inkfaint">
        {stats.depts} departments · {stats.pos} positions · {stats.people} people · {stats.open} open
      </div>
      <div className="pointer-events-none absolute bottom-3 left-1/2 hidden -translate-x-1/2 rounded-full border border-line bg-surface/90 px-2.5 py-1 text-2xs text-inkfaint lg:block">
        Scroll to zoom · drag to pan · click a node · {Math.round(view.scale * 100)}%
      </div>
    </div>
  );

  if (fullscreen) {
    return createPortal(
      <div className="fixed inset-0 z-50 bg-surface/98 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Organization graph — fullscreen">
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <div className="flex items-center gap-2">
              <Network className="h-4 w-4 text-brand" strokeWidth={2} />
              <p className="eyebrow">Organization graph</p>
            </div>
            <button onClick={onToggleFullscreen} className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-line px-3.5 text-xs text-inksoft transition-colors hover:bg-soft hover:text-ink" aria-label="Exit fullscreen">
              <Minimize2 className="h-3.5 w-3.5" strokeWidth={2} /> Exit fullscreen
            </button>
          </div>
          <div className="min-h-0 flex-1">{content}</div>
        </div>
      </div>,
      document.body,
    );
  }

  return content;
}

function collapsible(n: GNode, data: ExplorerData): boolean {
  if (n.type === 'dept') {
    return data.positions.some((p) => p.department_id === n.id);
  }
  if (n.type === 'position') {
    return data.people.some((p) => p.position_id === n.id);
  }
  return false;
}

const GraphNode = function GraphNode({ node, data, dimmed, selected, collapsed, collapsible: canCollapse, onSelect, onToggle, dragMoved }: {
  node: GNode;
  data: ExplorerData;
  dimmed: boolean;
  selected: boolean;
  collapsed: boolean;
  collapsible: boolean;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  dragMoved: () => boolean;
}) {
  const handle = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (dragMoved()) return;
    fn();
  };
  const { x, y, w, h } = node;

  if (node.type === 'org') {
    return (
      <g transform={`translate(${x} ${y})`} className="cursor-pointer" opacity={dimmed ? 0.25 : 1} style={{ transition: 'opacity 200ms' }} onClick={handle(() => onSelect('org-root'))} data-node>
        <rect width={w} height={h} rx={16} fill="#171411" />
        <text x={w / 2} y={34} textAnchor="middle" fontSize={20} fontWeight={700} fill="#FFFDF9" style={{ fontFamily: 'Fraunces, serif' }}>EduRankAI</text>
        <text x={w / 2} y={56} textAnchor="middle" fontSize={10.5} fill="#C9BFAE" style={{ fontFamily: 'Inter, sans-serif' }}>Organization</text>
      </g>
    );
  }

  if (node.type === 'dept') {
    const d = node.data as Dept | null;
    const positions = data.positions.filter((p) => p.department_id === node.id);
    const people = data.people.filter((p) => p.department_id === node.id);
    const open = positions.filter((p) => !data.people.some((pp) => pp.position_id === p.id)).length;
    return (
      <g transform={`translate(${x} ${y})`} className="cursor-pointer" opacity={dimmed ? 0.25 : 1} style={{ transition: 'opacity 200ms' }} onClick={handle(() => onSelect(node.id))} data-node>
        <rect width={w} height={h} rx={14} fill={selected ? '#FDF1E2' : '#FFFDF9'} stroke={selected ? '#FF5A1F' : '#E7DED2'} strokeWidth={selected ? 2 : 1} className="transition-colors" />
        <rect x={1} y={1} width={4} height={h - 2} rx={2} fill="#FF5A1F" opacity={0.9} />
        {canCollapse && (
          <g transform={`translate(12 ${h / 2 - 9})`} onClick={handle(() => onToggle(node.id))} className="cursor-pointer" aria-label={collapsed ? 'Expand department' : 'Collapse department'}>
            <circle r={9} fill={selected ? '#FFE3CF' : '#F7F3EC'} />
            {collapsed ? <ChevronRight className="h-3.5 w-3.5 text-inkfaint" strokeWidth={2} style={{ transform: 'translate(-7px -7px)' }} /> : <ChevronDown className="h-3.5 w-3.5 text-inkfaint" strokeWidth={2} style={{ transform: 'translate(-7px -7px)' }} />}
          </g>
        )}
        <text x={canCollapse ? 34 : 16} y={26} fontSize={15} fontWeight={650} fill="#171411" style={{ fontFamily: 'Fraunces, serif' }}>{node.label}</text>
        <text x={canCollapse ? 34 : 16} y={44} fontSize={10} fill="#8C857C" style={{ fontFamily: 'Inter, sans-serif' }}>
          {people.length} people · {positions.length} positions{open > 0 ? ` · ${open} open` : ''}
        </text>
        {d?.head_name && (
          <g>
            <text x={canCollapse ? 34 : 16} y={58} fontSize={10} fontWeight={600} fill="#C96A2B" style={{ fontFamily: 'Inter, sans-serif' }}>
              <tspan fill="#C96A2B">●</tspan> {d.head_name} · Department Lead
            </text>
          </g>
        )}
      </g>
    );
  }

  if (node.type === 'position') {
    const p = node.data as Pos | null;
    const holders = data.people.filter((pp) => pp.position_id === node.id);
    const isLead = Boolean(p?.head_of_department_id);
    const open = holders.length === 0;
    return (
      <g transform={`translate(${x} ${y})`} className="cursor-pointer" opacity={dimmed ? 0.25 : 1} style={{ transition: 'opacity 200ms' }} onClick={handle(() => onSelect(node.id))} data-node>
        <rect width={w} height={h} rx={11} fill={selected ? '#FDF1E2' : '#FFFDF9'} stroke={selected ? '#FF5A1F' : open ? '#E4B27A' : '#E7DED2'} strokeWidth={selected ? 2 : open ? 1.3 : 1} className="transition-colors" />
        {isLead && <Crown className="h-3 w-3 text-brand" strokeWidth={2} style={{ transform: `translate(${w - 20}px 8px)` }} />}
        <text x={14} y={21} fontSize={12} fontWeight={600} fill="#171411" style={{ fontFamily: 'Inter, sans-serif' }}>{truncate(node.label, 22)}</text>
        {open ? (
          <g>
            <rect x={14} y={30} width={78} height={16} rx={8} fill="#FBF0E2" />
            <text x={24} y={41} fontSize={9} fontWeight={700} letterSpacing="0.08em" fill="#B4541B" style={{ fontFamily: 'Inter, sans-serif' }}>OPEN POSITION</text>
          </g>
        ) : (
          <text x={14} y={41} fontSize={10} fill="#8C857C" style={{ fontFamily: 'Inter, sans-serif' }}>
            {holders.length} occupant{holders.length === 1 ? '' : 's'}{holders[0]?.grade ? ` · Grade ${holders[0].grade}` : ''}
          </text>
        )}
        {canCollapse && (
          <g transform={`translate(${w - 18} ${h / 2 - 9})`} onClick={handle(() => onToggle(node.id))} className="cursor-pointer" aria-label={collapsed ? 'Expand occupants' : 'Collapse occupants'}>
            <circle r={9} fill="#F7F3EC" />
            {collapsed ? <ChevronRight className="h-3 w-3 text-inkfaint" strokeWidth={2} style={{ transform: 'translate(-6px -6px)' }} /> : <ChevronDown className="h-3 w-3 text-inkfaint" strokeWidth={2} style={{ transform: 'translate(-6px -6px)' }} />}
          </g>
        )}
      </g>
    );
  }

  // person
  const person = node.data as Person | null;
  const pos = person?.position_id ? data.positions.find((x) => x.id === person!.position_id) : null;
  const initials = (person?.name ?? '?').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <g transform={`translate(${x} ${y})`} className="cursor-pointer" opacity={dimmed ? 0.18 : 1} style={{ transition: 'opacity 200ms' }} onClick={handle(() => onSelect(node.id))} data-node>
      <rect width={w} height={h} rx={10} fill={selected ? '#171411' : '#FFFDF9'} stroke={selected ? '#171411' : '#E7DED2'} strokeWidth={selected ? 1.6 : 1} className="transition-colors" />
      <circle cx={20} cy={22} r={11} fill={selected ? '#3A342C' : '#F1ECE3'} />
      <text x={20} y={25.5} textAnchor="middle" fontSize={9} fontWeight={700} fill={selected ? '#FFB89A' : '#8C857C'} style={{ fontFamily: 'Inter, sans-serif' }}>{initials}</text>
      <text x={38} y={19} fontSize={10.5} fontWeight={600} fill={selected ? '#FFFDF9' : '#171411'} style={{ fontFamily: 'Inter, sans-serif' }}>{truncate(node.label, 20)}</text>
      <text x={38} y={32.5} fontSize={9} fill={selected ? '#C9BFAE' : '#8C857C'} style={{ fontFamily: 'Inter, sans-serif' }}>{truncate(pos?.title ?? 'Unassigned', 24)}</text>
    </g>
  );
};

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}