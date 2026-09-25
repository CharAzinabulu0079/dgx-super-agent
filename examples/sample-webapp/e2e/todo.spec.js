import { test, expect } from '@playwright/test'

test('adds todos and counts what is left', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('new todo').fill('write receipts')
  await page.getByRole('button', { name: 'Add' }).click()
  await page.getByLabel('new todo').fill('verify independently')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('listitem')).toHaveCount(2)
  await expect(page.locator('#count')).toHaveText('2 items left')
})

test('completing a todo updates the counter', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('new todo').fill('ship v0.1')
  await page.keyboard.press('Enter')
  await page.getByRole('checkbox').check()
  await expect(page.locator('#count')).toHaveText('0 items left')
  await expect(page.getByRole('listitem')).toHaveClass('done')
})
