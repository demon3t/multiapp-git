import React from 'react';
import { RepositoryIcon } from './tab-appearance';

type RefNode = { ref?: string; children: Map<string, RefNode> };
type RefActions = { active?: string; disabled: boolean; onSelect: (ref: string) => void;
  onMenu?: (ref: string, anchor: HTMLButtonElement) => void; onSwitch?: (ref: string) => void };

function BranchNodes({ nodes, ...actions }: RefActions & { nodes: Map<string, RefNode> }) {
  return <ul>{[...nodes].map(([name, node]) => {
    const ref = node.ref;
    return <li key={name}>
      {ref && <button type="button" className="branch-ref" aria-current={ref === actions.active ? 'true' : undefined}
        disabled={actions.disabled} title={ref} aria-haspopup={actions.onMenu ? 'menu' : undefined}
        onClick={event => { if (event.detail < 2) actions.onSelect(ref); }}
        onContextMenu={event => {
          if (!actions.onMenu) return;
          event.preventDefault();
          actions.onMenu(ref, event.currentTarget);
        }}
        onDoubleClick={event => { if (event.button === 0) actions.onSwitch?.(ref); }}>
        {ref.startsWith('refs/tags/') ? <span className="branch-dot" aria-hidden="true"/> : <RepositoryIcon icon="branch"/>}
        <span>{name}</span>
      </button>}
      {node.children.size > 0 && <details open>
        <summary><RepositoryIcon icon="folder"/>{name}</summary>
        <BranchNodes nodes={node.children} {...actions}/>
      </details>}
    </li>;
  })}</ul>;
}

export function BranchList({ label, names, prefix, expanded, ...actions }: RefActions & {
  label: string; names: string[]; prefix: string; expanded?: boolean;
}) {
  const roots = new Map<string, RefNode>();
  for (const name of names) {
    let nodes = roots;
    const parts = name.split('/');
    for (const [index, part] of parts.entries()) {
      const node = nodes.get(part) ?? { children: new Map<string, RefNode>() };
      nodes.set(part, node);
      if (index === parts.length - 1) node.ref = prefix + name;
      nodes = node.children;
    }
  }
  return <details className="branch-group" open={expanded}>
    <summary>{label}</summary>
    {roots.size > 0 ? <BranchNodes nodes={roots} {...actions}/> : <p className="branch-empty">Пока пусто</p>}
  </details>;
}
