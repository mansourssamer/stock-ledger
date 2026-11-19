// Landed-cost recosting (app._recost_po_boxes): boxes in stock take the true cost; for
// pairs already sold, only the difference not yet posted goes in as a cost-of-goods
// correction, so nothing is ever counted twice.
import { run, ins } from '../localdb.js';
import { poCostPlan } from '../queries.js';
import { pyRound } from '../util.js';

export function recostPoBoxes(poId, reason = 'Landed cost updated') {
  const plan = poCostPlan(poId);
  for (const i of plan.items) {
    if (!i.sold && Math.abs(i.target - i.recorded) >= 0.00005) run(`UPDATE box_items SET unit_cost = ? WHERE id = ?`, [i.target, i.id]);
  }
  let fix = plan.fix;
  if (Math.abs(fix) >= 0.005) {
    ins('cogs_adjustments', { po_id: poId, amount_usd: pyRound(fix, 4), source: 'v2',
      description: `${reason} on PO #${poId} — share for ${plan.sold_pairs} pair(s) already sold` });
  } else fix = 0;
  return [plan.boxes_in_stock, plan.sold_pairs, pyRound(fix, 2)];
}
