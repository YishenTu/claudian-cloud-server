import type { ProjectScope } from '../../coordination/ProjectCoordination.js';

export async function hasNonterminalProjectMutation(
  scope: ProjectScope,
): Promise<boolean> {
  if (await scope.accept.getNonterminal() !== undefined) return true;
  if (await scope.getNonterminalDevelopmentBootstrapAttempt() !== undefined) {
    return true;
  }
  if (await scope.membership.getNonterminalJoin() !== undefined) return true;
  return await scope.portability.getNonterminalLifecycleJournal() !== undefined;
}
