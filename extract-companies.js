const fs = require("fs");
const path = require("path");

async function extractCompanies() {
  console.log(
    "⚡ Extracting full company list and counting problems from GitHub...",
  );
  try {
    const response = await fetch(
      "https://api.github.com/repos/liquidslr/leetcode-company-wise-problems/contents/",
    );
    const data = await response.json();

    if (Array.isArray(data)) {
      const folders = data.filter(
        (item) => item.type === "dir" && !item.name.startsWith("."),
      );
      const fetchedCompanies = [];

      console.log(
        `Found ${folders.length} companies. Counting problems (this will take a minute)...`,
      );

      // Loop through each folder to get the exact count from their 'All' CSV
      for (let i = 0; i < folders.length; i++) {
        const dir = folders[i];
        const rawName = decodeURIComponent(dir.name);
        let problemCount = null;

        try {
          // Fetch the All.csv directly
          const csvUrl = `https://raw.githubusercontent.com/liquidslr/leetcode-company-wise-problems/main/${dir.name}/5.%20All.csv`;
          const csvRes = await fetch(csvUrl);
          if (csvRes.ok) {
            const csvText = await csvRes.text();
            // Count lines, minus 1 for the header row
            const lines = csvText.split("\n").filter((l) => l.trim());
            problemCount = lines.length > 1 ? lines.length - 1 : 0;
          }
        } catch (err) {
          // Ignore individual fetch failures and just leave count as null
        }

        fetchedCompanies.push({
          name: rawName.replace("Facebook", "Meta"),
          slug: dir.name,
          logo: null,
          count: problemCount,
        });

        // Print progress every 50 companies so you know it isn't stuck
        if ((i + 1) % 50 === 0)
          console.log(`Processed ${i + 1}/${folders.length}...`);
      }

      const dataDir = path.join(__dirname, "data");
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir);
      }

      const filePath = path.join(dataDir, "companies.json");
      fs.writeFileSync(
        filePath,
        JSON.stringify(fetchedCompanies, null, 2),
        "utf8",
      );

      console.log(
        `✅ Successfully extracted and saved ${fetchedCompanies.length} companies with their true dynamic counts!`,
      );
    } else {
      console.error("❌ GitHub API Error:", data);
    }
  } catch (e) {
    console.error(e);
  }
}

extractCompanies();
