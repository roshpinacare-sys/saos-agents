import { statSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setInterval } from 'node:timers';

// Configuration
const MAX_REQUESTS_PER_SECOND = 800;
const SCALING_INTERVAL_MS = 5000;
const LOAD_SHEDDING_THRESHOLD = 0.9;
const AGGREGATOR_BATCH_SIZE = 50;
const METRICS_HISTORY_SIZE = 60;

// State
let currentCapacity = MAX_REQUESTS_PER_SECOND;
let requestQueue = [];
let pendingRequests = 0;
let metricsHistory = [];
let isOverloaded = false;

// Metrics tracking
function trackMetric(metricName, value) {
  const now = Date.now();
  
  if (!metricsHistory[now]) {
    metricsHistory[now] = {};
  }
  
  metricsHistory[now][metricName] = value;
  
  // Keep only recent metrics
  const cutoff = now - (METRICS_HISTORY_SIZE * 1000);
  Object.keys(metricsHistory).forEach(timestamp => {
    if (timestamp < cutoff) {
      delete metricsHistory[timestamp];
    }
  });
}

// Calculate system load based on metrics
function calculateLoad() {
  if (metricsHistory.length === 0) return 0;
  
  // Calculate average response time
  let totalResponseTime = 0;
  let responseTimeCount = 0;
  
  // Calculate average CPU utilization
  let totalCpu = 0;
  let cpuCount = 0;
  
  // Calculate queue size
  let maxQueueSize = 0;
  
  Object.values(metricsHistory).forEach(metrics => {
    if (metrics.responseTime) {
      totalResponseTime += metrics.responseTime;
      responseTimeCount++;
    }
    
    if (metrics.cpu) {
      totalCpu += metrics.cpu;
      cpuCount++;
    }
    
    if (metrics.queueSize > maxQueueSize) {
      maxQueueSize = metrics.queueSize;
    }
  });
  
  const avgResponseTime = responseTimeCount > 0 ? totalResponseTime / responseTimeCount : 0;
  const avgCpu = cpuCount > 0 ? totalCpu / cpuCount : 0;
  
  // Normalize metrics (0-1 scale)
  const normalizedResponseTime = Math.min(avgResponseTime / 1000, 1); // Assuming 1000ms as max
  const normalizedCpu = Math.min(avgCpu / 100, 1); // Assuming 100% as max
  const normalizedQueueSize = Math.min(maxQueueSize / (MAX_REQUESTS_PER_SECOND * 2), 1);
  
  // Calculate composite load metric (weighted average)
  const load = (normalizedResponseTime * 0.4) + 
                (normalizedCpu * 0.4) + 
                (normalizedQueueSize * 0.2);
  
  return Math.min(load, 1);
}

// Dynamic scaling logic
function adjustCapacity() {
  const load = calculateLoad();
  trackMetric('systemLoad', load);
  
  // Determine if we need to scale
  if (load > 0.7 && currentCapacity < MAX_REQUESTS_PER_SECOND * 2) {
    // Scale up
    const scaleFactor = 1 + (load - 0.7) * 0.5;
    currentCapacity = Math.min(
      Math.floor(currentCapacity * scaleFactor),
      MAX_REQUESTS_PER_SECOND * 2
    );
    console.log(`Scaling up capacity to: ${currentCapacity} req/s`);
  } else if (load < 0.4 && currentCapacity > MAX_REQUESTS_PER_SECOND) {
    // Scale down
    const scaleFactor = 1 - (0.4 - load) * 0.3;
    currentCapacity = Math.max(
      Math.floor(currentCapacity * scaleFactor),
      MAX_REQUESTS_PER_SECOND
    );
    console.log(`Scaling down capacity to: ${currentCapacity} req/s`);
  }
  
  // Check for load shedding
  if (load > LOAD_SHEDDING_THRESHOLD) {
    if (!isOverloaded) {
      console.log('System overload detected. Activating load shedding.');
      isOverloaded = true;
    }
  } else {
    if (isOverloaded) {
      console.log('System back to normal. Deactivating load shedding.');
      isOverloaded = false;
    }
  }
}

// Request aggregator
function processBatch() {
  if (requestQueue.length === 0) return;
  
  const batchSize = Math.min(AGGREGATOR_BATCH_SIZE, requestQueue.length);
  const batch = requestQueue.splice(0, batchSize);
  
  // Process the batch of requests
  batch.forEach(request => {
    pendingRequests++;
    
    // Simulate request processing
    setTimeout(() => {
      pendingRequests--;
      
      // Track metrics
      const responseTime = Math.random() * 500 + 100; // Random between 100-600ms
      const cpu = Math.random() * 30 + 10; // Random between 10-40%
      
      trackMetric('responseTime', responseTime);
      trackMetric('cpu', cpu);
      trackMetric('queueSize', requestQueue.length);
      
      // Execute the actual request handler
      if (typeof request.handler === 'function') {
        request.handler();
      }
    }, Math.random() * 200 + 50); // Random processing time
  });
}

// Handle incoming requests
function handleRequest(handler) {
  if (isOverloaded) {
    // Load shedding: reject the request
    console.log('Request rejected due to system overload');
    return false;
  }
  
  // Check if we're at capacity
  if (pendingRequests >= currentCapacity) {
    // Queue the request
    requestQueue.push({ handler });
    trackMetric('queueSize', requestQueue.length);
    console.log(`Queued request. Queue size: ${requestQueue.length}`);
    return true;
  }
  
  // Process immediately
  pendingRequests++;
  
  // Simulate request processing
  setTimeout(() => {
    pendingRequests--;
    
    // Track metrics
    const responseTime = Math.random() * 500 + 100; // Random between 100-600ms
    const cpu = Math.random() * 30 + 10; // Random between 10-40%
    
    trackMetric('responseTime', responseTime);
    trackMetric('cpu', cpu);
    trackMetric('queueSize', requestQueue.length);
    
    // Execute the actual request handler
    if (typeof handler === 'function') {
      handler();
    }
  }, Math.random() * 200 + 50); // Random processing time
  
  return true;
}

// Initialize the scaling system
function initScalingSystem() {
  // Create state directory if it doesn't exist
  if (!existsSync('state')) {
    mkdirSync('state');
  }
  
  // Start periodic capacity adjustment
  setInterval(adjustCapacity, SCALING_INTERVAL_MS);
  
  // Start batch processing
  setInterval(processBatch, 100);
  
  console.log(`Dynamic scaling system initialized with max capacity: ${MAX_REQUESTS_PER_SECOND} req/s`);
}

// Export functions for use in the agent system
export {
  initScalingSystem,
  handleRequest,
  trackMetric,
  calculateLoad,
  currentCapacity
};

// Test the system
function testScalingSystem() {
  console.log('Testing dynamic scaling system...');
  
  // Initialize
  initScalingSystem();
  
  // Simulate load
  let testRequestCount = 0;
  
  // Function to simulate a request
  const simulateRequest = () => {
    testRequestCount++;
    
    const success = handleRequest(() => {
      console.log(`Request ${testRequestCount} processed`);
    });
    
    if (!success) {
      console.log(`Request ${testRequestCount} was rejected due to overload`);
    }
  };
  
  // Send initial burst of requests
  for (let i = 0; i < 500; i++) {
    simulateRequest();
  }
  
  // Simulate increasing load over time
  const loadInterval = setInterval(() => {
    const requestsToAdd = Math.floor(Math.random() * 100) + 50;
    console.log(`Adding ${requestsToAdd} requests...`);
    
    for (let i = 0; i < requestsToAdd; i++) {
      simulateRequest();
    }
    
    // Stop after some time
    if (testRequestCount > 5000) {
      clearInterval(loadInterval);
      console.log('Test completed. Total requests processed:', testRequestCount);
    }
  }, 1000);
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testScalingSystem();
}
