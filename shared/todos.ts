// The model's checklist for a task with several steps, from its TodoWrite calls. Used by the server (reminders) and
// the GUI (the list shown beside the session).

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface Todo {
  content: string;
  status: TodoStatus;
}

const STATUSES = new Set<string>(['pending', 'in_progress', 'completed']);
export const MAX_TODOS = 50;

/** TodoWrite's `todos`: a list of {content, status}. Some models send the list as a JSON string. */
export function parseTodos(value: unknown): { todos: Todo[] } | { error: string } {
  let v = value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return { error: 'todos must be a list of {content, status} objects.' };
    }
  }
  if (!Array.isArray(v)) return { error: 'todos must be a list of {content, status} objects.' };
  if (v.length > MAX_TODOS) return { error: `Keep the list to ${MAX_TODOS} items or fewer.` };
  const todos: Todo[] = [];
  for (const item of v) {
    const content = typeof item?.content === 'string' ? item.content.trim() : '';
    if (!content) return { error: 'Each todo needs a content string.' };
    const status = STATUSES.has(item?.status) ? (item.status as TodoStatus) : 'pending';
    todos.push({ content, status });
  }
  return { todos };
}

export function unfinishedTodos(todos: Todo[]): Todo[] {
  return todos.filter((t) => t.status !== 'completed');
}
