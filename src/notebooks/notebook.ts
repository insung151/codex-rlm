import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson } from "../persistence/atomic.js";
import type { CellRecord, LaneRecord } from "../domain/types.js";
import { RlmError } from "../errors.js";

interface NotebookOutput {
  readonly output_type: string;
  readonly name?: string;
  readonly text?: readonly string[];
  readonly data?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly ename?: string;
  readonly evalue?: string;
  readonly traceback?: readonly string[];
}

export interface NotebookCell {
  readonly cell_type: "code";
  readonly execution_count: number;
  readonly metadata: {
    readonly rlm: {
      readonly lane_id: string;
      readonly agent_id: string | null;
      readonly source_execution_count: number;
      readonly status: CellRecord["status"];
      readonly truncated: boolean;
    };
  };
  readonly source: readonly string[];
  readonly outputs: readonly NotebookOutput[];
}

export interface NotebookDocument {
  readonly nbformat: 4;
  readonly nbformat_minor: 5;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly cells: readonly NotebookCell[];
}

export function emptyNotebook(lane: LaneRecord): NotebookDocument {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: {
        display_name: "Python 3 (Codex RLM local-process, non-hardened)",
        language: "python",
        name: "python3",
      },
      language_info: { name: "python", version: "3" },
      rlm: {
        lane_id: lane.id,
        backend: { kind: "local-process", hardened: false },
      },
    },
    cells: [],
  };
}

function lines(value: string): string[] {
  if (value.length === 0) {
    return [];
  }
  return value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export function cellToNotebookCell(
  lane: LaneRecord,
  cell: CellRecord,
): NotebookCell {
  const outputs: NotebookOutput[] = [];
  if (cell.stdout.length > 0) {
    outputs.push({
      output_type: "stream",
      name: "stdout",
      text: lines(cell.stdout),
    });
  }
  if (cell.stderr.length > 0) {
    outputs.push({
      output_type: "stream",
      name: "stderr",
      text: lines(cell.stderr),
    });
  }
  if (cell.result !== null) {
    outputs.push({
      output_type: "execute_result",
      data: { "text/plain": [cell.result] },
      metadata: {},
    });
  }
  if (cell.errorName !== null) {
    outputs.push({
      output_type: "error",
      ename: cell.errorName,
      evalue: cell.errorMessage ?? "",
      traceback: [],
    });
  }

  return {
    cell_type: "code",
    execution_count: cell.executionCount,
    metadata: {
      rlm: {
        lane_id: lane.id,
        agent_id: lane.agentDigest,
        source_execution_count: cell.executionCount,
        status: cell.status,
        truncated: cell.truncated,
      },
    },
    source: lines(cell.code),
    outputs,
  };
}

export async function readNotebook(path: string): Promise<NotebookDocument> {
  try {
    const notebook = JSON.parse(await readFile(path, "utf8")) as {
      readonly nbformat?: unknown;
      readonly cells?: unknown;
    };
    if (notebook.nbformat !== 4 || !Array.isArray(notebook.cells)) {
      throw new Error("invalid notebook structure");
    }
    return notebook as NotebookDocument;
  } catch (error: unknown) {
    if (error instanceof RlmError) {
      throw error;
    }
    throw new RlmError("PERSISTENCE_FAILED", "notebook could not be read");
  }
}

export async function appendCell(
  path: string,
  lane: LaneRecord,
  cell: CellRecord,
): Promise<void> {
  let notebook: NotebookDocument;
  try {
    notebook = await readNotebook(path);
  } catch (error: unknown) {
    notebook = emptyNotebook(lane);
  }
  await atomicWriteJson(path, {
    ...notebook,
    cells: [...notebook.cells, cellToNotebookCell(lane, cell)],
  });
}

export async function initializeLaneNotebook(
  artifactRoot: string,
  lane: LaneRecord,
): Promise<string> {
  const path = join(artifactRoot, "lanes", lane.id, "notebook.ipynb");
  await atomicWriteJson(path, emptyNotebook(lane));
  return path;
}

export function assembleMaster(
  lanes: readonly {
    readonly lane: LaneRecord;
    readonly notebook: NotebookDocument;
  }[],
): NotebookDocument {
  const ordered = [...lanes].sort(
    (left, right) => left.lane.creationIndex - right.lane.creationIndex,
  );
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      rlm: {
        assembly_order: ordered.map(({ lane }) => lane.id),
        backend: { kind: "local-process", hardened: false },
      },
    },
    cells: ordered.flatMap(({ notebook }) => notebook.cells),
  };
}
