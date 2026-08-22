import ELKModule from 'elkjs';
import type { Dept, Pos, Person, ExplorerData } from '../components/org/OrgExplorer';

const ELK: new () => { layout(graph: unknown): Promise<any> } =
  (ELKModule as any).ELK ?? (ELKModule as any).default ?? ELKModule;

export type GNodeType = 'org' | 'dept' | 'position' | 'person';

export interface GNode {
  id: string;
  type: GNodeType;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  deptId: string | null;
  data: Dept | Pos | Person | null;
}

export interface GEdge {
  id: string;
  source: string;
  target: string;
  kind: 'structure' | 'membership';
  points: { x: number; y: number }[];
}

export interface GCluster {
  deptId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OrgGraphLayout {
  nodes: GNode[];
  edges: GEdge[];
  clusters: GCluster[];
  width: number;
  height: number;
  byId: Map<string, GNode>;
}

export interface OrgModel {
  departments: Dept[];
  positions: Pos[];
  people: Person[];
}

// ------------------------------------------------------------------ sizing

const SIZES: Record<GNodeType, { w: number; h: number }> = {
  org: { w: 190, h: 78 },
  dept: { w: 224, h: 66 },
  position: { w: 196, h: 56 },
  person: { w: 196, h: 44 },
};

const PAD = 20; // cluster padding around a department subtree
const SUB_GAP = 14; // node-node gap inside a department
const LAYER_GAP = 48; // between levels inside a department
const COL_GAP = 30; // gap between the department column and subtrees

// ------------------------------------------------------------------ model

/** Canonical tree: org -> dept -> position -> person. No invented layers.
 *  `collapsed` holds dept ids and position ids; hidden nodes are excluded
 *  from the model so the layout engine never lays them out. */
export function buildOrgModel(data: ExplorerData, collapsed: Set<string>): OrgModel {
  const departments = data.departments;
  const positions = data.positions.filter((p) => !collapsed.has(p.department_id) && !collapsed.has(p.id));
  const people = data.people.filter(
    (p) => p.position_id && !collapsed.has(p.position_id) && (!p.department_id || !collapsed.has(p.department_id)),
  );
  return { departments, positions, people };
}

// ------------------------------------------------------------------ layout

const elk = new ELK();

async function layoutSubtree(
  model: OrgModel,
  rootDept: Dept,
  peopleByPosition: Map<string, Person[]>,
  posByDept: Map<string, Pos[]>,
): Promise<{ nodes: GNode[]; edges: GEdge[]; w: number; h: number }> {
  const children: any[] = [{ id: 'root:' + rootDept.id, width: SIZES.dept.w, height: SIZES.dept.h }];
  const edges: any[] = [];
  const nodeIds = new Set<string>(['root:' + rootDept.id]);

  const positions = posByDept.get(rootDept.id) ?? [];
  for (const p of positions) {
    const pid = 'pos:' + p.id;
    children.push({ id: pid, width: SIZES.position.w, height: SIZES.position.h });
    nodeIds.add(pid);
    edges.push({ id: 'e-root-' + p.id, sources: ['root:' + rootDept.id], targets: [pid] });
    const people = peopleByPosition.get(p.id) ?? [];
    for (const pp of people) {
      const ppid = 'per:' + pp.id;
      children.push({ id: ppid, width: SIZES.person.w, height: SIZES.person.h });
      nodeIds.add(ppid);
      edges.push({ id: 'e-' + p.id + '-' + pp.id, sources: [pid], targets: [ppid] });
    }
  }

  const graph: any = {
    id: 'sub:' + rootDept.id,
    layoutOptions: {
      'elk.algorithm': 'org.eclipse.elk.layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': String(SUB_GAP),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(LAYER_GAP),
      'elk.layered.crossingMinimization': 'interactive',
    },
    children,
    edges,
  };

  const res = await elk.layout(graph);
  const rootNode = res.children.find((c: any) => c.id === 'root:' + rootDept.id);
  const ox = rootNode.x;
  const oy = rootNode.y;

  const nodes: GNode[] = [];
  const outEdges: GEdge[] = [];
  for (const c of res.children) {
    const type: GNodeType = c.id.startsWith('root:') ? 'dept' : c.id.startsWith('pos:') ? 'position' : 'person';
    const id = c.id.replace(/^(root:|pos:|per:)/, '');
    nodes.push({
      id,
      type,
      label: type === 'dept' ? rootDept.name : type === 'position' ? (posById(id, model)?.title ?? id) : (personById(id, model)?.name ?? id),
      x: c.x - ox,
      y: c.y - oy,
      w: c.width,
      h: c.height,
      deptId: rootDept.id,
      data: type === 'dept' ? rootDept : type === 'position' ? (posById(id, model) ?? null) : (personById(id, model) ?? null),
    });
  }
  for (const e of res.edges ?? []) {
    const sourceId = e.sources[0].replace(/^(root:|pos:|per:)/, '');
    const targetId = e.targets[0].replace(/^(root:|pos:|per:)/, '');
    const points = collectPoints(e, ox, oy);
    outEdges.push({
      id: 'ge:' + sourceId + ':' + targetId,
      source: sourceId,
      target: targetId,
      kind: sourceId === rootDept.id ? 'structure' : 'membership',
      points,
    });
  }

  // normalize: shift so the top-left corner of the subtree sits at the origin
  let minX = Infinity, minY = Infinity;
  for (const n of nodes) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); }
  if (minX !== 0 || minY !== 0) {
    for (const n of nodes) { n.x -= minX; n.y -= minY; }
    for (const e of outEdges) { for (const p of e.points) { p.x -= minX; p.y -= minY; } }
  }

  return { nodes, edges: outEdges, w: res.width, h: res.height };
}

function posById(id: string, model: OrgModel): Pos | undefined {
  return model.positions.find((p) => p.id === id);
}
function personById(id: string, model: OrgModel): Person | undefined {
  return model.people.find((p) => p.id === id);
}

function collectPoints(e: any, ox: number, oy: number): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (const s of e.sections ?? []) {
    if (s.startPoint) pts.push({ x: s.startPoint.x - ox, y: s.startPoint.y - oy });
    for (const b of s.bendPoints ?? []) pts.push({ x: b.x - ox, y: b.y - oy });
    if (s.endPoint) pts.push({ x: s.endPoint.x - ox, y: s.endPoint.y - oy });
  }
  return pts;
}

export async function layoutOrgGraph(data: ExplorerData, collapsed: Set<string>): Promise<OrgGraphLayout> {
  const model = buildOrgModel(data, collapsed);
  const posByDept = new Map<string, Pos[]>();
  for (const p of model.positions) {
    const arr = posByDept.get(p.department_id) ?? [];
    arr.push(p);
    posByDept.set(p.department_id, arr);
  }
  const peopleByPosition = new Map<string, Person[]>();
  for (const p of model.people) {
    if (!p.position_id) continue;
    const arr = peopleByPosition.get(p.position_id) ?? [];
    arr.push(p);
    peopleByPosition.set(p.position_id, arr);
  }

  // 1) layout each department subtree (local space, dept root at origin)
  const subtrees = new Map<string, { nodes: GNode[]; edges: GEdge[]; w: number; h: number }>();
  for (const d of model.departments) {
    subtrees.set(d.id, await layoutSubtree(model, d, peopleByPosition, posByDept));
  }

  // 2) layout the department column: org + departments, sized by subtree height
  const roots = model.departments.filter((d) => !d.parent_department_id || !model.departments.some((x) => x.id === d.parent_department_id));
  const colChildren: any[] = [
    { id: 'org-root', width: SIZES.org.w, height: SIZES.org.h },
    ...model.departments.map((d) => ({
      id: 'col:' + d.id,
      width: SIZES.dept.w,
      height: (subtrees.get(d.id)?.h ?? SIZES.dept.h) + PAD * 2,
    })),
  ];
  const colEdges: any[] = [];
  for (const d of roots) {
    colEdges.push({ id: 'c-org-' + d.id, sources: ['org-root'], targets: ['col:' + d.id] });
  }
  for (const d of model.departments) {
    if (!d.parent_department_id) continue;
    if (!model.departments.some((x) => x.id === d.parent_department_id)) continue;
    colEdges.push({ id: 'c-' + d.parent_department_id + '-' + d.id, sources: ['col:' + d.parent_department_id], targets: ['col:' + d.id] });
  }
  const colGraph: any = {
    id: 'column',
    layoutOptions: {
      'elk.algorithm': 'org.eclipse.elk.layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '26',
      'elk.layered.spacing.nodeNodeBetweenLayers': String(COL_GAP),
      'elk.layered.crossingMinimization': 'interactive',
    },
    children: colChildren,
    edges: colEdges,
  };
  const colRes = await elk.layout(colGraph);
  const colNodes = new Map<string, { x: number; y: number }>();
  for (const c of colRes.children) {
    colNodes.set(c.id, { x: c.x, y: c.y });
  }
  const orgNode = colNodes.get('org-root')!;

  // 3) compose world layout
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const clusters: GCluster[] = [];

  nodes.push({
    id: 'org-root',
    type: 'org',
    label: 'EduRankAI',
    x: orgNode.x,
    y: orgNode.y,
    w: SIZES.org.w,
    h: SIZES.org.h,
    deptId: null,
    data: null,
  });

  for (const d of model.departments) {
    const col = colNodes.get('col:' + d.id)!;
    const sub = subtrees.get(d.id)!;
    const dx = col.x;
    const dy = col.y + PAD;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of sub.nodes) {
      nodes.push({ ...n, x: n.x + dx, y: n.y + dy });
      minX = Math.min(minX, n.x + dx);
      minY = Math.min(minY, n.y + dy);
      maxX = Math.max(maxX, n.x + dx + n.w);
      maxY = Math.max(maxY, n.y + dy + n.h);
    }
    for (const e of sub.edges) {
      edges.push({ ...e, points: e.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) });
    }
    clusters.push({
      deptId: d.id,
      x: minX - PAD,
      y: minY - PAD,
      w: maxX - minX + PAD * 2,
      h: maxY - minY + PAD * 2,
    });
  }

  // column edges (org -> dept, dept -> subdept)
  for (const e of colRes.edges ?? []) {
    const sourceRaw = e.sources[0];
    const targetRaw = e.targets[0];
    const sourceId = sourceRaw === 'org-root' ? 'org-root' : sourceRaw.replace(/^col:/, '');
    const targetId = targetRaw.replace(/^col:/, '');
    const points: { x: number; y: number }[] = [];
    for (const s of e.sections ?? []) {
      if (s.startPoint) points.push({ x: s.startPoint.x, y: s.startPoint.y });
      for (const b of s.bendPoints ?? []) points.push({ x: b.x, y: b.y });
      if (s.endPoint) points.push({ x: s.endPoint.x, y: s.endPoint.y });
    }
    edges.push({ id: 'gcol:' + sourceId + ':' + targetId, source: sourceId, target: targetId, kind: 'structure', points });
  }

  const width = Math.max(colRes.width, ...nodes.map((n) => n.x + n.w));
  const height = Math.max(colRes.height, ...nodes.map((n) => n.y + n.h));

  const byId = new Map(nodes.map((n) => [n.id, n]));
  return { nodes, edges, clusters, width, height, byId };
}

// ------------------------------------------------------------------ search

export interface OrgSearchResult {
  id: string;
  type: GNodeType;
  label: string;
  detail: string;
}

export function searchOrgGraph(data: ExplorerData, q: string): OrgSearchResult[] {
  const query = q.trim().toLowerCase();
  if (!query) return [];
  const out: OrgSearchResult[] = [];
  for (const d of data.departments) {
    if (d.name.toLowerCase().includes(query)) out.push({ id: d.id, type: 'dept', label: d.name, detail: 'Department' });
  }
  for (const p of data.positions) {
    if (p.title.toLowerCase().includes(query)) out.push({ id: p.id, type: 'position', label: p.title, detail: 'Position' });
  }
  for (const p of data.people) {
    const hay = `${p.name} ${p.skills.join(' ')} ${p.projects.join(' ')} ${p.grade ?? ''}`.toLowerCase();
    if (hay.includes(query)) {
      const pos = data.positions.find((x) => x.id === p.position_id);
      out.push({ id: p.id, type: 'person', label: p.name, detail: pos?.title ?? 'Member' });
    }
  }
  return out.slice(0, 12);
}