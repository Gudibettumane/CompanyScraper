async function processJob(jobId) {
  const job = activeJobs.get(jobId);
  if (!job) return;
  
  try {
    // Read Excel file
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(job.filePath);
    
    const worksheet = workbook.getWorksheet(1);
    const companies = [];
    
    // Find company column
    let companyColumnIndex = null;
    worksheet.getRow(1).eachCell((cell, colNumber) => {
      if (cell.value && cell.value.toString().toLowerCase().includes('company')) {
        companyColumnIndex = colNumber;
      }
    });
    
    if (!companyColumnIndex) {
      throw new Error('Could not find a column named "Company" in the Excel file');
    }
    
    // Extract company names
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1) { // Skip header row
        const company = row.getCell(companyColumnIndex).value;
        if (company) {
          companies.push(company.toString());
        }
      }
    });
    
    const total = companies.length;
    
    // Launch browser
    const browser = await puppeteer.launch({
      headless: "new", // Use new headless mode
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process' // May help with navigation issues
      ]
    });
    
    job.results = [];
    const page = await browser.newPage();
    
    // Set longer timeouts and handle navigation errors better
    page.setDefaultNavigationTimeout(30000); // 30 seconds
    page.setDefaultTimeout(30000);
    
    // Generate a unique base filename for this job
    const originalFilename = path.basename(job.filePath);
    const fileNameWithoutExt = path.parse(originalFilename).name;
    const date = new Date();
    const dateStr = date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const randomStr = Math.random().toString(36).substring(2, 10);
    const csvFilename = `${fileNameWithoutExt}_${dateStr}_${randomStr}.csv`;
    const csvPath = path.join(resultsDir, csvFilename);
    
    // Ensure results directory exists
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }
    
    // Write CSV header
    fs.writeFileSync(csvPath, 'Company,Website\n', 'utf-8');
    
    // Process each company and update the CSV file after each one
    for (let i = 0; i < companies.length; i++) {
      const company = companies[i];
      
      // Update job status
      job.progress = Math.floor(((i + 1) / total) * 100);
      job.currentCompany = company;
      
      let website = '';
      
      try {
        // Create a sanitized search query - remove or replace problematic characters
        const sanitizedCompany = company
          .replace(/[&\/\\#,+()$~%.'":*?<>{}]/g, ' ') // Replace special chars with spaces
          .replace(/\s+/g, ' ')                       // Replace multiple spaces with single space
          .trim();                                    // Trim spaces from ends
        
        const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(sanitizedCompany)}`;
        
        // Use a try-catch specifically for navigation
        try {
          await page.goto(searchUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 20000 // Increase timeout for problematic pages
          });
        } catch (navError) {
          console.warn(`Navigation error for ${company}, trying simplified query...`);
          
          // If the full company name fails, try with just the first part (before any comma or special char)
          const simplifiedCompany = sanitizedCompany.split(' ')[0];
          if (simplifiedCompany && simplifiedCompany.length > 3) {
            await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(simplifiedCompany)}`, {
              waitUntil: 'domcontentloaded',
              timeout: 20000
            });
          } else {
            throw navError; // Re-throw if we can't simplify further
          }
        }
        
        // Wait for search results with a more robust approach
        try {
          await page.waitForSelector('h2 > a, .b_algo h2 a', { timeout: 10000 });
        } catch (selectorError) {
          console.warn(`Selector not found for ${company}, continuing with extraction anyway...`);
          // Continue anyway, maybe there are still some elements we can extract
        }
        
        // Extract links with more defensive coding
        const links = await page.evaluate(() => {
          const linkElements = document.querySelectorAll('h2 > a, .b_algo h2 a');
          
          if (!linkElements || linkElements.length === 0) {
            return [];
          }
          
          return Array.from(linkElements).map(link => ({
            text: link.innerText || '',
            href: link.href || ''
          }));
        });
        
        // Find first valid link
        for (const link of links) {
          const href = link.href;
          if (href && 
              !href.includes('linkedin.com') && 
              !href.includes('bloomberg.com') &&
              !href.includes('zaubacorp.com') &&
              !href.includes('dnb.com') &&
              !href.includes('sgpbusiness.com')) {
            
            if (href.includes('bing.com/alink/link?url=')) {
              const parts = href.split('%3a%2f%2f');
              if (parts.length > 1) {
                const subParts = parts[1].split('2f&source');
                website = subParts[0] || '';
              }
            } else {
              website = href;
            }
            break;
          }
        }
      } catch (error) {
        console.error(`Error processing ${company}:`, error.message);
        // We'll continue with an empty website value in this case
      }
      
      // Always add result to the job's result array, even if there was an error
      const result = { company, website };
      job.results.push(result);
      
      // Safely append this entry to the CSV file
      try {
        const safeCsvLine = `"${company.replace(/"/g, '""')}","${(website || '').replace(/"/g, '""')}"\n`;
        fs.appendFileSync(csvPath, safeCsvLine, 'utf-8');
      } catch (writeError) {
        console.error(`Error writing to CSV for ${company}:`, writeError.message);
        // Try one more time with a more sanitized approach
        try {
          const emergencySafeLine = `"${company.replace(/[^\w\s]/g, ' ').replace(/"/g, '')}","${(website || '').replace(/[^\w\s:./\\-]/g, '').replace(/"/g, '')}"\n`;
          fs.appendFileSync(csvPath, emergencySafeLine, 'utf-8');
        } catch (finalError) {
          console.error(`Failed final attempt to write ${company} to CSV:`, finalError.message);
        }
      }
      
      // Add a small delay between requests to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // Close browser
    await browser.close();
    
    // Update job status to completed
    job.status = 'completed';
    job.progress = 100;
    job.csvPath = csvPath;
    job.csvFilename = csvFilename;
    
  } catch (error) {
    console.error('Error processing file:', error);
    job.status = 'error';
    job.error = error.message;
    
    // Even if there's a general error, we don't throw it
    // This allows the job to be marked as error but doesn't crash the server
  }
}