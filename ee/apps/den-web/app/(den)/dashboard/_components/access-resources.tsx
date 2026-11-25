"use client";

import { Blocks, BookOpen, Box, Cable, FileText, Plug, Sparkles, Store, Wand2, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import { DenCombobox, type DenComboboxOption } from "../../_components/ui/combobox";
import { DenInput } from "../../_components/ui/input";
import { DenSelect } from "../../_components/ui/select";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  accessResourceKindLabels,
  useAccessResources,
  type AccessResourceKind,
} from "./access-data";

const icons: Record<AccessResourceKind, typeof Box> = {
  model: Sparkles,
  llm_provider: Blocks,
  plugin: Box,
  marketplace: Store,
  config_object: Wand2,
  connector_instance: Cable,
  mcp_connection: Plug,
  capability: Wrench,
  knowledge_document: FileText,
  knowledge_chunk: BookOpen,
};

export type PickedResource = { kind: AccessResourceKind; id: string; label?: string };

const encode = (kind: string, id: string) => `${kind}\n${id}`;

/** Readable names for resources, so rules and requests never show a bare id when a name is known. */
export function useResourceNames() {
  const { orgId } = useOrgDashboard();
  const resources = useAccessResources(orgId);
  return useMemo(() => {
    const names = new Map((resources.data ?? []).map((resource) => [encode(resource.kind, resource.id), resource.label]));
    return (kind: AccessResourceKind, id: string, fallback?: string | null) => {
      if (id === "*") return `every ${accessResourceKindLabels[kind].noun}`;
      return names.get(encode(kind, id)) ?? fallback ?? `${accessResourceKindLabels[kind].noun} ${id}`;
    };
  }, [resources.data]);
}

export function ResourceIcon({ kind, className = "h-4 w-4 text-gray-500" }: { kind: AccessResourceKind; className?: string }) {
  const Icon = icons[kind];
  return <Icon className={className} aria-hidden="true" />;
}

/**
 * Pick a model, connection, tool, document… by name. `kinds` limits what is
 * offered; `allowEvery` adds "Every model" style entries for rules. When the
 * thing is not listed (a single tool, say), "Enter it by ID" is the way out.
 */
export function ResourcePicker({ value, onChange, kinds, allowEvery = false, ariaLabel = "What" }: {
  value: PickedResource | null;
  onChange: (value: PickedResource | null) => void;
  kinds: readonly AccessResourceKind[];
  allowEvery?: boolean;
  ariaLabel?: string;
}) {
  const { orgId } = useOrgDashboard();
  const resources = useAccessResources(orgId);
  const [manual, setManual] = useState(false);
  const listed = (resources.data ?? []).filter((resource) => kinds.includes(resource.kind));
  const options: DenComboboxOption[] = [
    ...(allowEvery ? kinds.map((kind) => ({
      value: encode(kind, "*"),
      label: `Every ${accessResourceKindLabels[kind].noun}`,
      description: `All ${accessResourceKindLabels[kind].plural.toLowerCase()}, including ones added later`,
      keywords: ["all", "every", kind],
      icon: <ResourceIcon kind={kind} />,
    })) : []),
    ...listed.map((resource) => ({
      value: encode(resource.kind, resource.id),
      label: resource.label,
      description: resource.detail ? `${accessResourceKindLabels[resource.kind].label} · ${resource.detail}` : accessResourceKindLabels[resource.kind].label,
      keywords: [resource.kind, accessResourceKindLabels[resource.kind].label, resource.id],
      icon: <ResourceIcon kind={resource.kind} />,
    })),
  ];
  // A resource that came in by link but is not in the list (yet) is still shown by name.
  if (value && !options.some((option) => option.value === encode(value.kind, value.id))) {
    options.unshift({ value: encode(value.kind, value.id), label: value.label ?? value.id, description: accessResourceKindLabels[value.kind].label, icon: <ResourceIcon kind={value.kind} /> });
  }

  if (manual) {
    const kind = value?.kind ?? kinds[0];
    return (
      <div className="space-y-2">
        <div className="flex gap-2">
          <div className="w-[160px] shrink-0">
            <DenSelect aria-label="Kind" value={kind} onChange={(event) => {
              const next = kinds.find((candidate) => candidate === event.target.value) ?? kinds[0];
              onChange(value?.id ? { kind: next, id: value.id } : null);
            }}>
              {kinds.map((candidate) => <option key={candidate} value={candidate}>{accessResourceKindLabels[candidate].label}</option>)}
            </DenSelect>
          </div>
          <DenInput aria-label="ID" value={value?.id ?? ""} placeholder={accessResourceKindLabels[kind].hint} onChange={(event) => onChange(event.target.value.trim() ? { kind, id: event.target.value.trim() } : null)} />
        </div>
        <button type="button" className="text-[12px] font-medium text-gray-500 hover:text-gray-800" onClick={() => { setManual(false); onChange(null); }}>
          Choose from the list instead
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <DenCombobox
        ariaLabel={ariaLabel}
        value={value ? encode(value.kind, value.id) : ""}
        options={options}
        placeholder={resources.isLoading ? "Loading…" : `Choose ${kinds.length === 1 ? `a ${accessResourceKindLabels[kinds[0]].noun}` : "what it's for"}`}
        searchPlaceholder="Search by name"
        emptyLabel="Nothing with that name"
        onChange={(raw) => {
          const [kind, ...rest] = raw.split("\n");
          const id = rest.join("\n");
          const match = kinds.find((candidate) => candidate === kind);
          if (!match) return;
          onChange({ kind: match, id, label: options.find((option) => option.value === raw)?.label });
        }}
      />
      <button type="button" className="text-[12px] font-medium text-gray-500 hover:text-gray-800" onClick={() => { setManual(true); onChange(null); }}>
        Not listed? Enter it by ID
      </button>
    </div>
  );
}
