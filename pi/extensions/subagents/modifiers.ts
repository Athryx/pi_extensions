/** Ordered name modifiers: bare names and +name add; -name removes. */
export function modifierName(value: string): string {
  return /^[+-]/.test(value) ? value.slice(1) : value;
}
export function modifiers(value: unknown, field: string, validateName?: (name: string) => void): string[] {
  if (!Array.isArray(value)) throw new Error(field + " must be an array of name modifiers");
  for (const entry of value) {
    if (typeof entry !== "string") throw new Error(field + " must contain strings");
    const name = modifierName(entry);
    if (!name || name !== name.trim() || /\s/.test(name) || /^[+-]/.test(name)) throw new Error(field + " contains an invalid name modifier: " + entry);
    validateName?.(name);
  }
  // Keep repetitions: +name, -name, +name must end with name enabled.
  return [...value];
}
export function applyModifiers(defaults: Iterable<string>, extra: readonly string[]): string[] {
  const names = new Set(defaults);
  for (const entry of extra) {
    const name = modifierName(entry);
    if (entry.startsWith("-")) names.delete(name);
    else names.add(name);
  }
  return [...names];
}
