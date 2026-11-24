import React from 'react';

type RefNode = { ref?: string; children: Map<string, RefNode> };
type RefActions = { active?: string; selected?: string; disabled: boolean; onSelect: (ref: string) => void; onCheckout?: (ref: string) => void };

function BranchNodes({ nodes, ...actions }: RefActions & { nodes: Map<string, RefNode> }) {
  return <ul>{[...nodes].map(([name, node]) => {
    const ref = node.ref;
    const current = ref !== undefined && ref === actions.active;
    return <li key={name}>
      {ref && <button type="button" className={'branch-ref' + (ref === actions.selected ? ' selected' : '')}
        aria-current={current ? 'true' : undefined} disabled={actions.disabled}
        title={actions.onCheckout ? ref + ' · Двойной щелчок для переключения' : ref}
        onClick={() => actions.onSelect(ref)} onDoubleClick={() => actions.onCheckout?.(ref)}>
        <span className="branch-dot" aria-hidden="true"/><span className="branch-name">{name}</span>
        {current && <span className="branch-current" aria-hidden="true">Текущая</span>}
      </button>}
      {node.children.size > 0 && <details open>
        <summary>{name}</summary>
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
