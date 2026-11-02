import { test, expect } from '@playwright/test';

test('ask page e2e: login + ask "what happened between 2pm and 3pm yesterday"', async ({ page }) => {
  // 1. Go to login page and authenticate
  await page.goto('http://localhost:3000/login');
  
  // Login with admin credentials (from auth.test.ts mock)
  await page.fill('input[name="username"]', 'admin-123');
  await page.fill('input[name="password"]', 'Password123!');
  await page.click('button:has-text("Login")');
  await page.waitForSelector('[data-test="chat-page"]', { timeout: 10000 });

  // 2. Go to Ask page
  await page.click('[href="/ask"]');
  await page.waitForSelector('[data-test="ask-input"]', { timeout: 5000 });

  // 3. Ask "what happened between 2pm and 3pm yesterday"
  await page.fill('[data-test="ask-input"]', 'what happened between 2pm and 3pm yesterday');
  await page.click('[data-test="ask-send"]');
  await page.waitForSelector('[data-test="chat-response"]', { timeout: 10000 });

  // 4. Verify answer contains meaningful content
  const answer = page.locator('[data-test="chat-response"]').innerText();
  console.log('Answer:', answer);
  
  // Should not be empty or error
  expect(answer.length).greaterThan(0);
  expect(answer).not.contain('Authentication token is required');
  expect(answer).not.contain('Error');
  
  // Print for user verification
  const ansText = await answer;
  console.log('=== PLAYWRIGHT E2E ANSWER ===');
  console.log(ansText);
});

