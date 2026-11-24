"use client";

import { Building2, Shield, User, Users } from "lucide-react";
import { useMemo } from "react";
import { DenCombobox, type DenComboboxOption } from "../../_components/ui/combobox";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import type { Principal, PrincipalKind } from "./access-data";

const icons: Record<PrincipalKind, typeof User> = { member: User, team: Users, role: Shield, org: Building2 };

export type PrincipalEntry = Principal & { label: string; detail: string };

/** Every principal a rule can name, with readable labels, from the org context already loaded. */
export function usePrincipalDirectory() {
  const { orgContext } = useOrgDashboard();
  return useMemo(() => {
    const entries: PrincipalEntry[] = [];
    if (!orgContext) return { entries, describe: (p: Principal) => ({ ...p, label: p.principalId, detail: p.principalKind }) };
    entries.push({ principalKind: "org", principalId: orgContext.organization.id, label: "Everyone", detail: `All of ${orgContext.organization.name}` });
    for (const team of orgContext.teams) {
      entries.push({ principalKind: "team", principalId: team.id, label: team.name, detail: `Team · ${team.memberIds.length} people${team.managedByScim ? " · from directory" : ""}` });
    }
    for (const role of orgContext.roles) {
      entries.push({ principalKind: "role", principalId: role.role, label: `Everyone with role ${role.role}`, detail: "Role" });
    }
    for (const member of orgContext.members) {
      if (!member.user) continue;
      entries.push({ principalKind: "member", principalId: member.id, label: member.user.name || member.user.email, detail: member.user.email });
    }
    const byKey = new Map(entries.map((entry) => [`${entry.principalKind}:${entry.principalId}`, entry]));
    const describe = (p: Principal): PrincipalEntry =>
      byKey.get(`${p.principalKind}:${p.principalId}`) ?? { ...p, label: p.principalKind === "member" ? "Former member" : p.principalId, detail: p.principalKind };
    return { entries, describe };
  }, [orgContext]);
}

export function memberName(entries: PrincipalEntry[], memberId: string) {
  return entries.find((entry) => entry.principalKind === "member" && entry.principalId === memberId)?.label ?? "A former member";
}

export function PrincipalChip({ principal }: { principal: PrincipalEntry }) {
  const Icon = icons[principal.principalKind];
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-1 text-[12px] font-medium text-gray-700" title={principal.detail}>
      <Icon className="h-3.5 w-3.5 shrink-0 text-gray-500" aria-hidden="true" />
      <span className="truncate">{principal.label}</span>
    </span>
  );
}

const encode = (p: Principal) => `${p.principalKind}:${p.principalId}`;

export function PrincipalPicker({ value, onChange, ariaLabel = "Who", only }: {
  value: Principal | null;
  onChange: (value: Principal) => void;
  ariaLabel?: string;
  only?: PrincipalKind[];
}) {
  const { entries } = usePrincipalDirectory();
  const options: DenComboboxOption[] = entries
    .filter((entry) => !only || only.includes(entry.principalKind))
    .map((entry) => {
      const Icon = icons[entry.principalKind];
      return { value: encode(entry), label: entry.label, description: entry.detail, keywords: [entry.principalKind], icon: <Icon className="h-4 w-4 text-gray-500" /> };
    });
  return (
    <DenCombobox
      ariaLabel={ariaLabel}
      value={value ? encode(value) : ""}
      options={options}
      placeholder="Choose a person, team, role, or everyone"
      searchPlaceholder="Search people, teams and roles"
      onChange={(raw) => {
        const entry = entries.find((candidate) => encode(candidate) === raw);
        if (entry) onChange({ principalKind: entry.principalKind, principalId: entry.principalId });
      }}
    />
  );
}
