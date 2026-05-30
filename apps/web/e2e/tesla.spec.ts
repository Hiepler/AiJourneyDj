import { expect, test, type Page } from "@playwright/test";

async function mockApi(page: Page) {
  await page.route("http://localhost:3000/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === "/health") {
      return route.fulfill({
        json: {
          ok: true,
          tidalConnected: true,
          tidalMock: true,
          spotifyConnected: true,
          spotifyMock: true,
          spotifyPremium: true,
          xaiMock: true,
          songScout: {
            provider: "gemini",
            model: "gemini-3.5-flash",
            webSearch: false,
            mock: true
          },
          telemetryEnabled: false,
          journeyRefreshMinutes: 12
        }
      });
    }

    if (url.pathname === "/history") {
      return route.fulfill({ json: { journeys: [] } });
    }

    if (url.pathname === "/journeys" && request.method() === "POST") {
      return route.fulfill({
        status: 201,
        json: {
          id: "journey-1",
          provider: "spotify",
          destination: "Lago di Garda",
          userPrompt: "golden hour drive",
          passengerMode: "couple",
          phase: "departure",
          status: "active",
          createdAtIso: "2026-05-29T10:00:00.000Z"
        }
      });
    }

    if (url.pathname === "/journeys/journey-1/playback/device" && request.method() === "POST") {
      return route.fulfill({
        json: {
          journeyId: "journey-1",
          provider: "spotify",
          deviceId: "mock-webplayer",
          status: "ready",
          queuedTrackIds: [],
          targetBufferSize: 5,
          lastHeartbeatAt: "2026-05-29T10:00:00.000Z"
        }
      });
    }

    if (url.pathname === "/journeys/journey-1/analyze" && request.method() === "POST") {
      return route.fulfill({
        json: {
          id: "update-1",
          batchSize: 5,
          status: "success",
          createdAtIso: "2026-05-29T10:01:00.000Z"
        }
      });
    }

    if (url.pathname === "/journeys/journey-1") {
      return route.fulfill({
        json: {
          needsAnalysis: false,
          journey: {
            id: "journey-1",
            provider: "spotify",
            destination: "Lago di Garda",
            userPrompt: "golden hour drive",
            passengerMode: "couple",
            phase: "departure",
            status: "active",
            createdAtIso: "2026-05-29T10:00:00.000Z"
          },
          latestUpdate: {
            id: "update-1",
            batchSize: 5,
            status: "success",
            createdAtIso: "2026-05-29T10:01:00.000Z"
          },
          playbackSession: {
            journeyId: "journey-1",
            provider: "spotify",
            deviceId: "tesla-webplayer",
            status: "playing",
            activeTrack: {
              id: "track-active",
              provider: "spotify",
              providerTrackId: "active",
              providerUri: "spotify:track:active",
              artist: "M83",
              title: "Wait",
              matchConfidence: 0.98,
              matchReason: "isrc match",
              addedToPlaylist: true
            },
            queuedTrackIds: ["track-1", "track-2", "track-3", "track-4", "track-5"],
            targetBufferSize: 5,
            lastHeartbeatAt: "2026-05-29T10:01:00.000Z"
          },
          tracks: Array.from({ length: 5 }, (_, index) => ({
            id: `track-${index + 1}`,
            provider: "spotify",
            providerTrackId: `track-${index + 1}`,
            providerUri: `spotify:track:${index + 1}`,
            artist: "Artist",
            title: `Queue Track ${index + 1}`,
            matchConfidence: 0.9,
            matchReason: "test",
            addedToPlaylist: true
          }))
        }
      });
    }

    return route.fulfill({ status: 404, json: { error: "Unhandled mock route" } });
  });
}

async function expectNoControlOverlap(page: Page) {
  const boxes = await page.locator("button:visible, a:visible").evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        text: node.textContent?.trim() ?? "",
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom
      };
    })
  );

  for (let index = 0; index < boxes.length; index += 1) {
    for (let next = index + 1; next < boxes.length; next += 1) {
      const a = boxes[index];
      const b = boxes[next];
      const overlaps = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      expect(overlaps, `${a.text} overlaps ${b.text}`).toBe(false);
    }
  }
}

test("shows Spotify default queue flow without overlapping controls", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");

  await expect(page.getByText("Demo mode")).toBeVisible();
  await page.getByRole("button", { name: "Start Journey" }).click();

  await expect(page.getByRole("heading", { name: "Now playing" })).toBeVisible();
  await expect(page.getByText("5/5")).toBeVisible();
  await expect(page.getByText("Queue Track 5")).toBeVisible();
  await expectNoControlOverlap(page);
});
