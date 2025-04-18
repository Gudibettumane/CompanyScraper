const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const puppeteer = require('puppeteer');
const { v4: uuidv4 } = require('uuid');
const { networkInterfaces } = require('os');

const app = express();
const port = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve static files from 'public' directory

// Configure file storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ storage });

// Create directory for results
const resultsDir = path.join(__dirname, 'results');
if (!fs.existsSync(resultsDir)) {
  fs.mkdirSync(resultsDir, { recursive: true });
}

// Session tracking for active jobs
const activeJobs = new Map();

// API: File upload endpoint
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  const jobId = uuidv4();
  const filePath = req.file.path;
  
  // Store job in active jobs
  activeJobs.set(jobId, {
    filePath,
    status: 'uploaded',
    progress: 0,
    currentCompany: '',
    results: [],
    shouldStop: false,
    startTime: null,
    endTime: null,
    processed: 0,
    total: 0,
    successCount: 0,
    failureCount: 0,
    companyTimes: [], // Array to store processing time for each company
    estimatedTimeRemaining: null, // Store estimated time remaining
    lastSpeedCalculation: null, // Last time we calculated processing speed
    processingSpeed: null // Companies per second
  });
  
  return res.json({
    success: true,
    jobId,
    fileName: req.file.originalname
  });
});

// API: Get job status
app.get('/api/job/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = activeJobs.get(jobId);
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const resultsCount = job.results.length;
  // Get the last 10 results instead of the first 10
  const lastTenResults = resultsCount <= 10 
    ? job.results.slice(0) // Return all if less than 10
    : job.results.slice(resultsCount - 10, resultsCount); // Return the last 10 items
  
  // Calculate average processing time and success ratio
  let avgProcessingTime = 0;
  if (job.companyTimes.length > 0) {
    const sum = job.companyTimes.reduce((a, b) => a + b, 0);
    avgProcessingTime = sum / job.companyTimes.length;
  }
  
  // Calculate total duration
  let totalDuration = 0;
  if (job.startTime) {
    const endTimeToUse = job.endTime || new Date();
    totalDuration = (endTimeToUse - job.startTime) / 1000; // in seconds
  }
  
  // Calculate success ratio
  const successRatio = job.processed > 0 ? (job.successCount / job.processed) * 100 : 0;
  
  // Calculate ETA
  let eta = null;
  if (job.status === 'processing' && job.processingSpeed > 0 && job.total > 0 && job.processed > 0) {
    // How many companies are left
    const remaining = job.total - job.processed;
    // How many seconds it will take to process them
    const secondsRemaining = remaining / job.processingSpeed;
    eta = secondsRemaining;
  }
  
  return res.json({
    jobId,
    status: job.status,
    progress: job.progress,
    currentCompany: job.currentCompany,
    resultCount: job.results.length,
    processed: job.processed,
    total: job.total,
    successCount: job.successCount, 
    failureCount: job.failureCount,
    successRatio: successRatio.toFixed(2),
    avgProcessingTime: avgProcessingTime.toFixed(2),
    totalDuration: totalDuration.toFixed(2),
    eta: eta, // Estimated time remaining in seconds
    processingSpeed: job.processingSpeed ? job.processingSpeed.toFixed(4) : null, // Companies per second
    // Return the first 10 results for preview
    preview: lastTenResults
  });
});

// API: Start processing a job
app.post('/api/process/:jobId', async (req, res) => {
  const jobId = req.params.jobId;
  const job = activeJobs.get(jobId);
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  // Only start if not already processing
  if (job.status === 'processing') {
    return res.json({ success: false, message: 'Job is already processing' });
  }
  
  // Reset stop flag
  job.shouldStop = false;
  
  // Update job status
  job.status = 'processing';
  job.progress = 0;
  job.startTime = new Date();
  job.endTime = null;
  job.lastSpeedCalculation = new Date();
  job.processingSpeed = null;
  
  // Process in background
  processJob(jobId).catch(error => {
    console.error(`Error processing job ${jobId}:`, error);
    const job = activeJobs.get(jobId);
    if (job) {
      job.status = 'error';
      job.error = error.message;
      job.endTime = new Date();
    }
  });
  
  return res.json({ success: true });
});

// API: Stop processing a job
app.post('/api/stop/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = activeJobs.get(jobId);
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  // Set the stop flag
  job.shouldStop = true;
  
  return res.json({ 
    success: true, 
    message: 'Stop signal sent. The job will stop after the current company is processed.' 
  });
});

// API: Download results
app.get('/api/download/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = activeJobs.get(jobId);
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  const csvPath = job.csvPath;
  if (!fs.existsSync(csvPath)) {
    return res.status(404).json({ error: 'Result file not found' });
  }
  
  res.download(csvPath);
});

// API: List all active jobs
app.get('/api/jobs', (req, res) => {
  const jobs = [];
  activeJobs.forEach((job, jobId) => {
    let totalDuration = 0;
    if (job.startTime) {
      const endTimeToUse = job.endTime || new Date();
      totalDuration = (endTimeToUse - job.startTime) / 1000; // in seconds
    }
    
    // Calculate ETA
    let eta = null;
    if (job.status === 'processing' && job.processingSpeed > 0 && job.total > 0 && job.processed > 0) {
      // How many companies are left
      const remaining = job.total - job.processed;
      // How many seconds it will take to process them
      const secondsRemaining = remaining / job.processingSpeed;
      eta = secondsRemaining;
    }
    
    jobs.push({
      jobId,
      status: job.status,
      progress: job.progress,
      fileName: path.basename(job.filePath),
      resultCount: job.results ? job.results.length : 0,
      processed: job.processed || 0,
      total: job.total || 0,
      totalDuration: totalDuration.toFixed(2),
      eta: eta
    });
  });
  
  res.json({ jobs });
});

// Function to process an Excel file and scrape websites
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
    job.total = total;
    job.processed = 0;
    job.successCount = 0;
    job.failureCount = 0;
    
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
    
    fs.writeFileSync(csvPath, 'Company,Website\n', 'utf-8');
    
    // Process each company and update the CSV file after each one
    for (let i = 0; i < companies.length; i++) {
      // Check if we should stop
      if (job.shouldStop) {
        console.log(`Job ${jobId} stopped by user after processing ${i} companies`);
        job.status = 'stopped';
        job.endTime = new Date();
        break;
      }
      
      const company = companies[i];
      const companyStartTime = Date.now();
      
      // Update job status
      job.progress = Math.floor(((i + 1) / total) * 100);
      job.currentCompany = company;
      job.processed = i + 1;
      
      let website = '';
      let success = false;
      
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
        
        // If we found a website, consider it success
        success = !!website;
      } catch (error) {
        console.error(`Error processing ${company}:`, error.message);
        success = false;
      }
      
      // Calculate processing time for this company
      const processingTime = Date.now() - companyStartTime;
      job.companyTimes.push(processingTime);
      
      // Update success/failure counts
      if (success) {
        job.successCount++;
      } else {
        job.failureCount++;
      }
      
      // Always add result to the job's result array, even if there was an error
      const result = { 
        company, 
        website, 
        processingTime 
      };
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
      
      // Update processing speed and ETA calculation every 5 companies or 30 seconds
      const now = new Date();
      const secondsSinceLastCalculation = (now - job.lastSpeedCalculation) / 1000;
      
      if (i > 0 && (i % 5 === 0 || secondsSinceLastCalculation > 30)) {
        // Calculate speed: companies processed per second
        const elapsedSeconds = (now - job.startTime) / 1000;
        job.processingSpeed = job.processed / elapsedSeconds;
        
        // Calculate ETA
        if (job.processingSpeed > 0) {
          const remaining = total - job.processed;
          job.estimatedTimeRemaining = remaining / job.processingSpeed;
        }
        
        job.lastSpeedCalculation = now;
      }
      
      // Add a small delay between requests to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // Close browser
    await browser.close();
    
    // Update job status to completed if not stopped
    if (job.status !== 'stopped') {
      job.status = 'completed';
    }
    
    job.progress = Math.floor((job.processed / total) * 100);
    job.endTime = new Date();
    job.csvPath = csvPath;
    job.csvFilename = csvFilename;
    
  } catch (error) {
    console.error('Error processing file:', error);
    job.status = 'error';
    job.error = error.message;
    job.endTime = new Date();
    
    // Even if there's a general error, we don't throw it
    // This allows the job to be marked as error but doesn't crash the server
  }
}

// Serve the React app for any other route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Helper function to get all local IP addresses
function getLocalIPs() {
  const interfaces = networkInterfaces();
  const ipAddresses = [];
  
  for (const interfaceName in interfaces) {
    const interfaceInfo = interfaces[interfaceName];
    
    for (const iface of interfaceInfo) {
      // Skip over non-IPv4 and internal (loopback) addresses
      if (iface.family === 'IPv4' && !iface.internal) {
        ipAddresses.push(iface.address);
      }
    }
  }
  
  return ipAddresses;
}

// Start server
app.listen(port, '0.0.0.0', () => {
  console.log(`\n=== Company Website Scraper Server ===`);
  console.log(`Server running at http://localhost:${port}`);
  
  // Get and display all local IP addresses
  const ipAddresses = getLocalIPs();
  
  if (ipAddresses.length > 0) {
    console.log(`\nAccess from other devices using one of these URLs:`);
    ipAddresses.forEach(ip => {
      console.log(`http://${ip}:${port}`);
    });
  } else {
    console.log(`\nNo network interfaces found. Make sure you're connected to a network.`);
  }
  
  console.log(`\nPress Ctrl+C to stop the server`);
});