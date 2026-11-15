import dagre from '@dagrejs/dagre';
import type { VariantKey } from '@contracts';
import {
    Background,
    Controls,
    Handle,
    MarkerType,
    Position,
    ReactFlow,
    ReactFlowProvider,
    useReactFlow,
    type Edge,
    type Node,
    type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { memo, useEffect, useMemo } from 'react';
import { entryStatus, runFileUrl, screenLabel, shotFor, type Entry, type Model } from './model';
import { StatusDot } from './ui';

interface Props {
    model: Model;
    entries: Entry[];
    variant: VariantKey;
    selectedId?: string;
    onSelect: (id: string | undefined) => void;
}

type ScreenNodeData = {
    entry: Entry;
    variant: VariantKey;
    width: number;
    thumbHeight: number;
    selected: boolean;
    dimmed: boolean;
};

const LABEL_HEIGHT = 40;

export function MapView(props: Props) {
    return (
        <ReactFlowProvider>
            <MapCanvas {...props} />
        </ReactFlowProvider>
    );
}

function MapCanvas({ model, entries, variant, selectedId, onSelect }: Props) {
    const viewport = model.map.run.viewports.find((v) => v.id === variant.viewport) ?? model.map.run.viewports[0];
    const width = viewport.width < 700 ? 132 : 240;
    const thumbHeight = Math.round(width * (viewport.height / viewport.width));

    const ids = useMemo(() => new Set(entries.map((e) => e.id)), [entries]);
    const transitions = useMemo(() => model.transitions.filter((t) => ids.has(t.from) && ids.has(t.to)), [model.transitions, ids]);

    // Lay out on a spanning tree (the link that first reached each screen) so shared nav links don't tangle the graph.
    const { positions, treeEdges } = useMemo(() => {
        const g = new dagre.graphlib.Graph();
        g.setGraph({ rankdir: 'LR', nodesep: 36, ranksep: 110, marginx: 40, marginy: 40 });
        g.setDefaultEdgeLabel(() => ({}));
        for (const entry of entries) g.setNode(entry.id, { width, height: thumbHeight + LABEL_HEIGHT });
        const parent = new Map<string, string>();
        const depth = new Map(entries.map((e) => [e.id, e.screen.depth]));
        for (const t of transitions) {
            if (parent.has(t.to)) continue;
            const fromDepth = depth.get(t.from) ?? 0;
            const toDepth = depth.get(t.to) ?? 0;
            if (t.kind === 'state' || fromDepth < toDepth) parent.set(t.to, t.from);
        }
        for (const [to, from] of parent) g.setEdge(from, to);
        dagre.layout(g);
        const positions = new Map(
            entries.map((e) => {
                const n = g.node(e.id);
                return [e.id, { x: n.x - n.width / 2, y: n.y - n.height / 2 }];
            }),
        );
        return { positions, treeEdges: new Set([...parent].map(([to, from]) => `${from}->${to}`)) };
    }, [entries, transitions, width, thumbHeight]);

    const connected = useMemo(() => {
        if (!selectedId) return null;
        const set = new Set([selectedId]);
        for (const t of transitions) {
            if (t.from === selectedId) set.add(t.to);
            if (t.to === selectedId) set.add(t.from);
        }
        return set;
    }, [selectedId, transitions]);

    const nodes: Node<ScreenNodeData>[] = useMemo(
        () =>
            entries.map((entry) => ({
                id: entry.id,
                type: 'screen',
                position: positions.get(entry.id) ?? { x: 0, y: 0 },
                data: { entry, variant, width, thumbHeight, selected: entry.id === selectedId, dimmed: connected !== null && !connected.has(entry.id) },
                draggable: false,
            })),
        [entries, positions, variant, width, thumbHeight, selectedId, connected],
    );

    // Draw the tree by default; the selected screen shows every link in and out.
    const edges: Edge[] = useMemo(
        () =>
            transitions
                .filter((t) => treeEdges.has(t.id) || t.from === selectedId || t.to === selectedId)
                .map((t) => {
                const out = t.from === selectedId;
                const into = t.to === selectedId;
                const active = out || into;
                return {
                    id: t.id,
                    source: t.from,
                    target: t.to,
                    type: 'default',
                    className: `edge${active ? (out ? ' edge-out' : ' edge-in') : ''}${selectedId && !active ? ' edge-faded' : ''}${t.kind === 'state' ? ' edge-state' : ''}`,
                    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
                    zIndex: active ? 10 : 0,
                };
            }),
        [transitions, treeEdges, selectedId],
    );

    return (
        <div className="map">
            <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={NODE_TYPES}
                onNodeClick={(_, node) => onSelect(node.id)}
                onPaneClick={() => onSelect(undefined)}
                fitView
                fitViewOptions={{ padding: 0.12 }}
                minZoom={0.1}
                maxZoom={2.5}
                proOptions={{ hideAttribution: true }}
                nodesConnectable={false}
                elementsSelectable={false}
            >
                <Background gap={24} size={1} />
                <Controls showInteractive={false} position="bottom-left" />
                <FitOnChange signature={`${model.title}|${variant.viewport}|${entries.length}`} />
                <FocusSelected id={selectedId} />
            </ReactFlow>
        </div>
    );
}

function FitOnChange({ signature }: { signature: string }) {
    const flow = useReactFlow();
    useEffect(() => {
        const id = requestAnimationFrame(() => flow.fitView({ padding: 0.12, duration: 0 }));
        return () => cancelAnimationFrame(id);
    }, [signature, flow]);
    return null;
}

/** Pans to the selected screen when it is off screen (keyboard stepping, inspector links). */
function FocusSelected({ id }: { id?: string }) {
    const flow = useReactFlow();
    useEffect(() => {
        if (!id) return;
        const node = flow.getNode(id);
        if (!node || !node.measured?.width) return;
        const { x, y, zoom } = flow.getViewport();
        const el = document.querySelector('.map');
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const left = node.position.x * zoom + x;
        const top = node.position.y * zoom + y;
        const right = left + node.measured.width * zoom;
        const bottom = top + (node.measured.height ?? 0) * zoom;
        if (left < 0 || top < 0 || right > rect.width || bottom > rect.height) {
            flow.setCenter(node.position.x + node.measured.width / 2, node.position.y + (node.measured.height ?? 0) / 2, { zoom, duration: 220 });
        }
    }, [id, flow]);
    return null;
}

const ScreenNode = memo(function ScreenNode({ data }: NodeProps<Node<ScreenNodeData>>) {
    const { entry, variant, width, thumbHeight, selected, dimmed } = data;
    const status = entryStatus(entry, variant);
    const shot = shotFor(entry.screen, variant);
    return (
        <div className={`node${selected ? ' node-selected' : ''}${dimmed ? ' node-dimmed' : ''}${status ? ` node-${status}` : ''}`} style={{ width }}>
            <Handle type="target" position={Position.Left} isConnectable={false} />
            <div className="node-thumb" style={{ height: thumbHeight }}>
                {shot ? <img src={runFileUrl(entry.runId, shot.path)} alt="" loading="lazy" draggable={false} /> : <div className="node-missing">No shot</div>}
            </div>
            <div className="node-label">
                <StatusDot status={status} />
                <span className="node-route" title={screenLabel(entry.screen)}>
                    {entry.screen.route}
                </span>
                {entry.screen.state && <span className="node-state">{entry.screen.state}</span>}
            </div>
            <Handle type="source" position={Position.Right} isConnectable={false} />
        </div>
    );
});

const NODE_TYPES = { screen: ScreenNode };
