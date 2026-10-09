const STATUS_LABELS = { want_to_read: 'Want to read', reading: 'Reading', finished: 'Finished' };

const state = { page: 1, status: '' };
const list = document.getElementById('books');
const errorBox = document.getElementById('error');

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
  if (res.status === 204) return null;
  const body = await res.json();
  if (!res.ok) throw new Error(body.error);
  return body;
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function renderBook(book) {
  const item = el('li');
  item.append(el('strong', book.title), el('div', `by ${book.author}`, 'meta'));
  if (book.notes) item.append(el('div', book.notes));
  if (book.legacyNotes) item.append(el('div', `Imported note: ${book.legacyNotes}`, 'legacy'));

  const select = el('select');
  select.setAttribute('aria-label', `Status of ${book.title}`);
  for (const [value, label] of Object.entries(STATUS_LABELS)) {
    const option = el('option', label);
    option.value = value;
    option.selected = value === book.status;
    select.append(option);
  }
  select.addEventListener('change', () =>
    run(() => api(`/api/books/${book.id}`, { method: 'PATCH', body: JSON.stringify({ status: select.value }) })),
  );

  const remove = el('button', 'Remove');
  remove.type = 'button';
  remove.addEventListener('click', () => run(() => api(`/api/books/${book.id}`, { method: 'DELETE' })));

  item.append(select, remove);
  return item;
}

async function load() {
  const params = new URLSearchParams({ page: String(state.page) });
  if (state.status) params.set('status', state.status);
  const data = await api(`/api/books?${params}`);
  state.page = data.page;
  list.replaceChildren(...data.items.map(renderBook));
  if (data.items.length === 0) list.append(el('li', 'No books here yet.', 'meta'));
  document.getElementById('page-info').textContent = `Page ${data.page} of ${data.totalPages}`;
  document.getElementById('prev').disabled = data.page <= 1;
  document.getElementById('next').disabled = data.page >= data.totalPages;
}

async function run(action) {
  errorBox.textContent = '';
  try {
    await action();
    await load();
  } catch (err) {
    errorBox.textContent = err.message;
  }
}

document.getElementById('add-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  const { title, author } = form.elements;
  const body = JSON.stringify({ title: title.value, author: author.value });
  run(async () => {
    await api('/api/books', { method: 'POST', body });
    form.reset();
  });
});

document.getElementById('status-filter').addEventListener('change', (event) => {
  state.status = event.target.value;
  state.page = 1;
  run(() => null);
});

document.getElementById('prev').addEventListener('click', () => {
  state.page -= 1;
  run(() => null);
});

document.getElementById('next').addEventListener('click', () => {
  state.page += 1;
  run(() => null);
});

run(() => null);
