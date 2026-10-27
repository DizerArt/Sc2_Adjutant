// Shared vector icons and counter geometry for Canvas and exported Pillow frames.
const mineral = [
  { kind: 'polygon', fill: '#26758f', points: [[-17, 0], [-15, -13], [-9, -17], [-4, -5], [-6, 12]] },
  { kind: 'polygon', fill: '#76dfed', points: [[-15, -13], [-9, -17], [-9, 3], [-6, 12], [-17, 0]] },
  { kind: 'polygon', fill: '#2993b2', points: [[-7, -10], [0, -22], [8, -9], [7, 12], [0, 17], [-8, 9]] },
  { kind: 'polygon', fill: '#b4f5fb', points: [[-7, -10], [0, -22], [0, 2], [-8, 9]] },
  { kind: 'polygon', fill: '#5cd3e5', points: [[0, -22], [8, -9], [0, 2]] },
  { kind: 'polygon', fill: '#42bbd5', points: [[0, 2], [7, 12], [0, 17], [-8, 9]] },
  { kind: 'polygon', fill: '#349ab1', points: [[7, -4], [13, -14], [19, -7], [17, 7], [10, 12], [6, 6]] },
  { kind: 'polygon', fill: '#88e8ef', points: [[7, -4], [13, -14], [13, 1], [10, 12], [6, 6]] },
];
const vespene = [
  { kind: 'ellipse', fill: '#28684c', bounds: [-18, -8, 0, 12] },
  { kind: 'ellipse', fill: '#387e51', bounds: [-4, -9, 18, 13] },
  { kind: 'ellipse', fill: '#52af6e', bounds: [-11, -21, 10, 2] },
  { kind: 'ellipse', fill: '#71d98b', bounds: [-15, -7, -1, 6] },
  { kind: 'ellipse', fill: '#8de79b', bounds: [-7, -18, 6, -6] },
  { kind: 'ellipse', fill: '#64ca80', bounds: [2, -6, 15, 7] },
  { kind: 'ellipse', fill: '#c6f6bb', bounds: [-4, -17, 2, -12] },
  { kind: 'ellipse', fill: '#9eeeaa', bounds: [-13, -5, -9, -1] },
];
export function resourceCounters(state, panel) {
  const half = (panel.w - 48) / 2;
  return [['minerals', '#71ddea', mineral], ['gas', '#8ce3a0', vespene]].map(([key, color, shapes], i) => {
    const x = panel.x + 42 + i * half, y = panel.y + 78;
    return { key, label: key === 'minerals' ? 'Минералы' : 'Веспен', color,
      value: state.unknown === 0 ? String(state[key]).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f') : '—',
      text: { x: x + 28, y: y + 13, size: 27 },
      shapes: shapes.map(s => s.kind === 'polygon'
        ? { ...s, points: s.points.map(([px, py]) => [x + px, y + py]) }
        : { ...s, bounds: s.bounds.map((v, n) => v + (n % 2 ? y : x)) }) };
  });
}
