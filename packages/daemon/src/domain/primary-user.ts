/**
 * The primary user: the person at the terminal, whose authority every terminal action carries. Only one person is expected
 * to be typing into a terminal; everyone else reaches the team through an external channel. There's no terminal login or
 * identity challenge.
 *
 * It's the default participant: the participants side file's `default` once that lands (0.7.3 slice 01), otherwise the only
 * registered person. With several people and no default it's unnamed (null), and terminal actions are still the primary
 * user's.
 */
export function primaryUserAddress(people: readonly string[]): string | null {
  return people.length === 1 ? people[0]! : null;
}
