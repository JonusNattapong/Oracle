/**
 * Memory Graph Visualization Component
 * Displays entity graph relationships, node memory counts, and directional edges.
 */

export interface GraphNode {
  id: string;
  label: string;
  type: "service" | "tech" | "concept";
  memoryCount: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: "mentions" | "depends-on" | "stores-in";
  weight: number;
}

export interface MemoryGraphProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onEntityClick?: (entityId: string) => void;
  loading?: boolean;
}

/**
 * Memory Graph Component rendering entity nodes and connection edges.
 */
export function MemoryGraph(props: MemoryGraphProps) {
  if (props.loading) {
    return <div className="memory-graph-loading">Loading Entity Graph...</div>;
  }

  if (!props.nodes.length) {
    return <div className="memory-graph-empty">No graph entities recorded.</div>;
  }

  return (
    <div className="memory-graph-container" style={{ padding: "16px", border: "1px solid #ccc", borderRadius: "8px" }}>
      <h3 style={{ margin: "0 0 12px 0" }}>Memory Entity Graph ({props.nodes.length} nodes)</h3>
      <div className="nodes-list" style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
        {props.nodes.map((node) => (
          <div
            key={node.id}
            onClick={() => props.onEntityClick?.(node.id)}
            style={{
              padding: "6px 12px",
              borderRadius: "16px",
              background: node.type === "service" ? "#e3f2fd" : node.type === "tech" ? "#f3e5f5" : "#e8f5e9",
              color: "#333",
              cursor: "pointer",
              fontSize: "14px",
              fontWeight: 500
            }}
          >
            {node.label} ({node.memoryCount})
          </div>
        ))}
      </div>
      <div className="edges-list" style={{ marginTop: "12px", fontSize: "13px", color: "#666" }}>
        <strong>Relationships ({props.edges.length}):</strong>
        <ul style={{ margin: "4px 0 0 0", paddingLeft: "20px" }}>
          {props.edges.map((edge, idx) => (
            <li key={`${edge.source}-${edge.target}-${idx}`}>
              {edge.source} &rarr; <em>{edge.type}</em> &rarr; {edge.target} (weight: {edge.weight})
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
