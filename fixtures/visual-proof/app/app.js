// Renders the orders screen in the state named by ?state= (success when absent).
const main = document.getElementById('main');
const state = new URLSearchParams(location.search).get('state') || 'success';
const orders = [['1001', 'Ada Lovelace', 'Shipped'], ['1002', 'Alan Turing', 'Pending'], ['1003', 'Grace Hopper', 'Delivered']];

if (state === 'loading') {
  main.innerHTML = '<p class="state-msg" data-state="loading" role="status">Loading orders...</p>';
} else if (state === 'empty') {
  main.innerHTML = '<p class="state-msg" data-state="empty">No orders yet. New orders appear here.</p>';
} else {
  main.innerHTML = '<section data-state="success"><h2>Recent orders</h2>'
    + '<table><thead><tr><th>Order</th><th>Customer</th><th>Status</th></tr></thead><tbody>'
    + orders.map(([id, who, st]) => `<tr><td>${id}</td><td>${who}</td><td>${st}</td></tr>`).join('')
    + '</tbody></table><h2>Recommended</h2><div class="carousel">'
    + ['Gift cards', 'Bulk pricing', 'Returns', 'Order history'].map((t, i) => `<div class="card"><p>${t}</p><a href="#p${i}">Open ${t}</a></div>`).join('')
    + '</div></section>';
}

document.getElementById('search').addEventListener('submit', (e) => {
  e.preventDefault();
  document.getElementById('search-error').hidden = document.getElementById('q').value.trim() !== '';
});
document.getElementById('clear-search').addEventListener('click', () => { document.getElementById('q').value = ''; });
// Trap (EXPECTED.md 14): a call to a backend outside the page's origin (a stand-in for an API with a database).
// measure.mjs must block it before it leaves the browser and list it under network.blocked; it is no failure.
fetch('http://127.0.0.1:9/api/orders').catch(() => {});
