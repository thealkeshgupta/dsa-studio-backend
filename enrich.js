const fs = require("fs");
const path = require("path");

async function enrichLists() {
  console.log("⚡ Fetching master difficulty map from LeetCode...");

  try {
    // 1. Fetch all ~3300 problems in one fast request
    const response = await fetch(
      "https://leetcode.com/api/problems/algorithms/",
    );
    const data = await response.json();

    const difficultyMap = {};
    const levelToText = { 1: "Easy", 2: "Medium", 3: "Hard" };

    if (data.stat_status_pairs) {
      data.stat_status_pairs.forEach((pair) => {
        const slug = pair.stat.question__title_slug;
        const level = pair.difficulty.level;
        difficultyMap[slug] = levelToText[level];
      });
    }

    console.log(
      `✅ Successfully mapped ${Object.keys(difficultyMap).length} problems.\n`,
    );

    // 2. Locate your lists directory
    const listsDir = path.join(__dirname, "data", "lists");
    if (!fs.existsSync(listsDir)) {
      console.error("❌ Lists directory not found at:", listsDir);
      return;
    }

    const files = fs.readdirSync(listsDir).filter((f) => f.endsWith(".json"));

    // 3. Iterate, enrich, and save every JSON file
    for (const file of files) {
      const filePath = path.join(listsDir, file);
      const fileData = JSON.parse(fs.readFileSync(filePath, "utf8"));

      let updatedCount = 0;
      let missingCount = 0;

      if (fileData.steps) {
        fileData.steps.forEach((step) => {
          if (step.subTopics) {
            step.subTopics.forEach((sub) => {
              if (sub.problems) {
                sub.problems.forEach((prob) => {
                  // Only map LeetCode problems that have a valid slug
                  if (prob.platform === "LeetCode" && prob.slug) {
                    const actualDiff = difficultyMap[prob.slug];
                    if (actualDiff) {
                      // Inject or overwrite the difficulty property
                      prob.difficulty = actualDiff;
                      updatedCount++;
                    } else {
                      missingCount++;
                    }
                  }
                });
              }
            });
          }
        });
      }

      // Save the beautifully formatted, enriched JSON back to the file
      fs.writeFileSync(filePath, JSON.stringify(fileData, null, 2), "utf8");
      console.log(
        `📁 ${file}: Mapped ${updatedCount} difficulties. (${missingCount} unmapped)`,
      );
    }

    console.log(
      "\n🎉 Enrichment complete! Restart your frontend to see the changes.",
    );
  } catch (err) {
    console.error("Error during enrichment:", err);
  }
}

enrichLists();
