const todos = []
const list = document.getElementById('list')
const count = document.getElementById('count')
function render() {
  list.innerHTML = ''
  for (const [i, t] of todos.entries()) {
    const li = document.createElement('li')
    li.className = t.done ? 'done' : ''
    li.innerHTML = `<label><input type="checkbox" ${t.done ? 'checked' : ''}> <span></span></label>`
    li.querySelector('span').textContent = t.text
    li.querySelector('input').addEventListener('change', () => { todos[i].done = !todos[i].done; render() })
    list.appendChild(li)
  }
  const left = todos.filter(t => !t.done).length
  count.textContent = `${left} item${left === 1 ? '' : 's'} left`
}
document.getElementById('add').addEventListener('submit', e => {
  e.preventDefault()
  const input = document.getElementById('new')
  if (input.value.trim()) todos.push({ text: input.value.trim(), done: false })
  input.value = ''
  render()
})
render()
