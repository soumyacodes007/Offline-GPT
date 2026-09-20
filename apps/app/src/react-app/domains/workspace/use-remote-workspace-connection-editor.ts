/** @jsxImportSource react */
import { useCallback, useMemo, useState } from "react";

import {
  workspaceUpdateRemote,
  type WorkspaceInfo,
} from "../../../app/lib/desktop";
import { buildOfflineGptWorkspaceBaseUrl, type OfflineGptServerClient } from "../../../app/lib/offlinegpt-server";
import { isDesktopRuntime } from "../../../app/lib/runtime-env";
import { t } from "../../../i18n";
import type { RemoteWorkspaceInput } from "./types";

function describeEditorError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    const serialized = JSON.stringify(error);
    return serialized && serialized !== "{}" ? serialized : t("app.unknown_error");
  } catch {
    return t("app.unknown_error");
  }
}

export function useRemoteWorkspaceConnectionEditor<TWorkspace extends WorkspaceInfo>(input: {
  workspaces: TWorkspace[];
  client: OfflineGptServerClient | null;
  onSaved: (workspaceId: string) => void | Promise<void>;
}) {
  const { client, onSaved, workspaces } = input;
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const workspace = useMemo(
    () =>
      workspaceId
        ? workspaces.find(
            (item) =>
              item.id === workspaceId && item.workspaceType === "remote",
          ) ?? null
        : null,
    [workspaces, workspaceId],
  );

  const initialValues = useMemo(
    () => {
      const hostUrl = workspace?.offlinegptHostUrl ?? workspace?.baseUrl ?? "";
      const mountedUrl = workspace?.remoteType === "offlinegpt"
        ? buildOfflineGptWorkspaceBaseUrl(hostUrl, workspace.offlinegptWorkspaceId) ?? hostUrl
        : hostUrl;
      return {
        offlinegptHostUrl: mountedUrl,
        offlinegptToken:
          workspace?.offlinegptToken ??
          workspace?.offlinegptClientToken ??
          workspace?.offlinegptHostToken ??
          "",
        directory: workspace?.directory ?? workspace?.path ?? "",
        displayName: workspace?.displayName ?? workspace?.name ?? "",
      };
    },
    [workspace],
  );

  const open = useCallback(
    (nextWorkspaceId: string) => {
      const next = workspaces.find((item) => item.id === nextWorkspaceId);
      if (!next || next.workspaceType !== "remote") return;
      setWorkspaceId(nextWorkspaceId);
      setError(null);
    },
    [workspaces],
  );

  const close = useCallback(() => {
    if (busy) return;
    setWorkspaceId(null);
    setError(null);
  }, [busy]);

  const save = useCallback(
    async (fields: RemoteWorkspaceInput) => {
      const id = workspaceId?.trim() ?? "";
      const baseUrl = fields.offlinegptHostUrl?.trim() ?? "";
      if (!id || !baseUrl) {
        setError(t("dashboard.remote_base_url_required"));
        return;
      }

      setBusy(true);
      setError(null);
      try {
        const displayName = fields.displayName?.trim() || null;
        const directory = fields.directory?.trim() || null;
        const offlinegptToken = fields.offlinegptToken?.trim() ?? "";
        if (isDesktopRuntime()) {
          await workspaceUpdateRemote({
            workspaceId: id,
            baseUrl,
            offlinegptHostUrl: baseUrl,
            offlinegptToken,
            offlinegptClientToken: "",
            offlinegptHostToken: "",
            displayName,
            directory,
            remoteType: "offlinegpt",
          });
          await onSaved(id);
        } else {
          if (!client) throw new Error(t("app.error_connect_first"));
          const connectionChanged = baseUrl !== (initialValues.offlinegptHostUrl?.trim() ?? "") ||
            offlinegptToken !== (initialValues.offlinegptToken?.trim() ?? "") ||
            directory !== (initialValues.directory?.trim() || null);
          if (connectionChanged) {
            const result = await client.createRemoteWorkspace({
              baseUrl,
              offlinegptHostUrl: baseUrl,
              offlinegptToken: offlinegptToken || null,
              displayName,
              directory,
              remoteType: "offlinegpt",
            });
            await onSaved(result.activeId ?? id);
          } else {
            await client.updateWorkspaceDisplayName(id, displayName);
            await onSaved(id);
          }
        }
        setWorkspaceId(null);
      } catch (nextError) {
        setError(describeEditorError(nextError));
      } finally {
        setBusy(false);
      }
    },
    [client, initialValues.directory, initialValues.offlinegptHostUrl, initialValues.offlinegptToken, onSaved, workspaceId],
  );

  return {
    workspace,
    busy,
    error,
    initialValues,
    open,
    close,
    save,
  };
}
