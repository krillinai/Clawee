export function getEnterpriseAccountDisplayName(name: string): string {
  const displayName = name.trim();
  const compactName = displayName.replace(/[\s()+-]/g, '');
  if (!displayName || /1[3-9]\d{9}/.test(compactName)) return '企业用户';
  return displayName;
}
