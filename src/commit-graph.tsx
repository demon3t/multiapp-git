import React, { useLayoutEffect, useRef } from 'react';
import type { GitCommit } from './core/public';

type Lane = { sha: string; color: number };
type Line = { from: number; to: number; half: 'top' | 'bottom' | 'both'; color: number };
const colors = ['#246fc1', '#8b53bf', '#168365', '#c26420', '#cb4e76', '#16818c'];
export const graphRowHeight = 27;
const laneWidth = 13;

export function layoutGraph(commits: GitCommit[]) {
  const lanes: (Lane | undefined)[] = [];
  let nextColor = 0;
  let width = 48;
  const rows = commits.map(commit => {
    let column = lanes.findIndex(lane => lane?.sha === commit.sha);
    const incoming = column >= 0;
    if (!incoming) {
      column = lanes.indexOf(undefined);
      if (column < 0) column = lanes.length;
    }
    const color = lanes[column]?.color ?? nextColor++;
    const lines: Line[] = [];
    lanes.forEach((lane, index) => {
      if (lane && index !== column) lines.push({ from: index, to: index, half: 'both', color: lane.color });
    });
    if (incoming) lines.push({ from: column, to: column, half: 'top', color });
    lanes[column] = undefined;
    commit.parents.forEach((sha, index) => {
      let target = lanes.findIndex(lane => lane?.sha === sha);
      let targetColor = lanes[target]?.color;
      if (target < 0) {
        target = index === 0 ? column : lanes.indexOf(undefined);
        if (target < 0) target = lanes.length;
        targetColor = index === 0 ? color : nextColor++;
        lanes[target] = { sha, color: targetColor };
      }
      lines.push({ from: column, to: target, half: 'bottom', color: targetColor ?? color });
    });
    width = Math.max(width, (Math.max(column + 1, lanes.length) + 1) * laneWidth);
    while (lanes.length && !lanes.at(-1)) lanes.pop();
    return { lines, column, color, merge: commit.parents.length > 1 };
  });
  return { rows, width };
}

export function GraphCell({ row, width }: { row: ReturnType<typeof layoutGraph>['rows'][number]; width: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const ratio = window.devicePixelRatio || 1;
    const element = canvas.current!;
    element.width = Math.ceil(width * ratio);
    element.height = Math.ceil(graphRowHeight * ratio);
    const ctx = element.getContext('2d');
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    const x = (lane: number) => 10 + lane * laneWidth;
    const middle = graphRowHeight / 2;
    ctx.lineWidth = 1.6;
    for (const line of row.lines) {
      ctx.strokeStyle = colors[line.color % colors.length];
      ctx.beginPath();
      ctx.moveTo(x(line.from), line.half === 'bottom' ? middle : 0);
      const end = line.half === 'top' ? middle : graphRowHeight;
      if (line.from === line.to) ctx.lineTo(x(line.to), end);
      else ctx.bezierCurveTo(x(line.from), middle + 5, x(line.to), end - 6, x(line.to), end);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(x(row.column), middle, row.merge ? 4.2 : 3.4, 0, 2 * Math.PI);
    ctx.fillStyle = row.merge ? '#fff' : colors[row.color % colors.length];
    ctx.strokeStyle = colors[row.color % colors.length];
    ctx.fill();
    ctx.stroke();
  }, [row, width]);
  return <canvas ref={canvas} style={{ width, height: graphRowHeight }} aria-hidden="true"/>;
}
