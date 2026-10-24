package main

import (
	"container/heap"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sync"
	"time"
)

// Agent represents a worker in the system
type Agent struct {
	ID           string
	Capacity     float64
	CurrentLoad  float64
	LastActive   time.Time
	IsAvailable  bool
}

// Request represents a task request from the system
type Request struct {
	ID            string
	Priority      float64
	WaitTime      time.Duration
	RequiredTime  float64
	ArrivalTime   time.Time
}

// LoadBalancer manages agent capacity and request distribution
type LoadBalancer struct {
	mutex          sync.Mutex
	agents         []*Agent
	requestQueue   RequestQueue
	metrics        LoadMetrics
	config         LoadBalancerConfig
	lastAdjustment time.Time
}

// LoadMetrics tracks system-wide load metrics
type LoadMetrics struct {
	TotalRequests      int
	ActiveRequests     int
	AverageWaitTime    time.Duration
	PeakLoad           float64
	CurrentCapacity    float64
	TargetCapacity     float64
}

// LoadBalancerConfig holds configuration for the load balancer
type LoadBalancerConfig struct {
	MinAgents         int
	MaxAgents         int
	TargetUtilization float64
	AdjustmentInterval time.Duration
	MaxWaitTime       time.Duration
}

// RequestQueue is a priority queue for requests
type RequestQueue []*Request

func (pq RequestQueue) Len() int { return len(pq) }

func (pq RequestQueue) Less(i, j int) bool {
	// Higher priority first, then shorter wait time
	if pq[i].Priority != pq[j].Priority {
		return pq[i].Priority > pq[j].Priority
	}
	return time.Since(pq[i].ArrivalTime) > time.Since(pq[j].ArrivalTime)
}

func (pq RequestQueue) Swap(i, j int) {
	pq[i], pq[j] = pq[j], pq[i]
}

func (pq *RequestQueue) Push(x interface{}) {
	item := x.(*Request)
	*pq = append(*pq, item)
}

func (pq *RequestQueue) Pop() interface{} {
	n := len(*pq)
	item := (*pq)[n-1]
	(*pq)[n-1] = nil // avoid memory leak
	*pq = (*pq)[0 : n-1]
	return item
}

// NewLoadBalancer creates a new load balancer instance
func NewLoadBalancer(config LoadBalancerConfig) *LoadBalancer {
	lb := &LoadBalancer{
		agents:        make([]*Agent, 0, config.MaxAgents),
		requestQueue:  make(RequestQueue, 0),
		metrics:       LoadMetrics{},
		config:        config,
		lastAdjustment: time.Now(),
	}
	
	// Initialize with minimum agents
	for i := 0; i < config.MinAgents; i++ {
		lb.AddAgent()
	}
	
	return lb
}

// AddAgent adds a new agent to the system
func (lb *LoadBalancer) AddAgent() {
	lb.mutex.Lock()
	defer lb.mutex.Unlock()
	
	if len(lb.agents) >= lb.config.MaxAgents {
		return
	}
	
	agent := &Agent{
		ID:          fmt.Sprintf("agent-%d", len(lb.agents)+1),
		Capacity:    1.0,
		CurrentLoad: 0.0,
		LastActive:  time.Now(),
		IsAvailable: true,
	}
	
	lb.agents = append(lb.agents, agent)
	lb.metrics.CurrentCapacity += agent.Capacity
	lb.metrics.TargetCapacity = lb.metrics.CurrentCapacity
}

// RemoveAgent removes an agent from the system
func (lb *LoadBalancer) RemoveAgent() {
	lb.mutex.Lock()
	defer lb.mutex.Unlock()
	
	if len(lb.agents) <= lb.config.MinAgents {
		return
	}
	
	// Find the least busy agent to remove
	idx := 0
	minLoad := lb.agents[0].CurrentLoad
	for i, agent := range lb.agents {
		if agent.CurrentLoad < minLoad {
			minLoad = agent.CurrentLoad
			idx = i
		}
	}
	
	removedAgent := lb.agents[idx]
	lb.agents = append(lb.agents[:idx], lb.agents[idx+1:]...)
	lb.metrics.CurrentCapacity -= removedAgent.Capacity
}

// AdjustCapacity dynamically adjusts the number of agents based on load
func (lb *LoadBalancer) AdjustCapacity() {
	lb.mutex.Lock()
	defer lb.mutex.Unlock()
	
	now := time.Now()
	if now.Sub(lb.lastAdjustment) < lb.config.AdjustmentInterval {
		return
	}
	
	// Calculate current utilization
	utilization := lb.metrics.CurrentLoad / lb.metrics.CurrentCapacity
	if lb.metrics.CurrentCapacity == 0 {
		utilization = 0
	}
	
	// Determine if we need to add or remove agents
	if utilization > lb.config.TargetUtilization && len(lb.agents) < lb.config.MaxAgents {
		// Scale up gradually
		needed := int(math.Ceil((utilization - lb.config.TargetUtilization) * float64(len(lb.agents)) * 2))
		for i := 0; i < needed && len(lb.agents) < lb.config.MaxAgents; i++ {
			lb.AddAgent()
		}
	} else if utilization < lb.config.TargetUtilization*0.8 && len(lb.agents) > lb.config.MinAgents {
		// Scale down gradually
		needed := int(math.Ceil((lb.config.TargetUtilization*0.8 - utilization) * float64(len(lb.agents)) * 2))
		for i := 0; i < needed && len(lb.agents) > lb.config.MinAgents; i++ {
			lb.RemoveAgent()
		}
	}
	
	lb.lastAdjustment = now
}

// AddRequest adds a new request to the queue
func (lb *LoadBalancer) AddRequest(req Request) {
	lb.mutex.Lock()
	defer lb.mutex.Unlock()
	
	lb.metrics.TotalRequests++
	heap.Push(&lb.requestQueue, &req)
	lb.metrics.CurrentLoad += req.RequiredTime
	
	// Update peak load if needed
	if lb.metrics.CurrentLoad > lb.metrics.PeakLoad {
		lb.metrics.PeakLoad = lb.metrics.CurrentLoad
	}
}

// DistributeRequests assigns queued requests to available agents
func (lb *LoadBalancer) DistributeRequests() {
	lb.mutex.Lock()
	defer lb.mutex.Unlock()
	
	// Adjust capacity based on current load
	lb.AdjustCapacity()
	
	// Process requests in priority order
	for lb.requestQueue.Len() > 0 {
		req := heap.Pop(&lb.requestQueue).(*Request)
		
		// Find an available agent
		assigned := false
		for _, agent := range lb.agents {
			if agent.IsAvailable && agent.CurrentLoad+req.RequiredTime <= agent.Capacity {
				// Assign request to agent
				agent.CurrentLoad += req.RequiredTime
				agent.LastActive = time.Now()
				assigned = true
				break
			}
		}
		
		if !assigned {
			// No available agent, put request back in queue
			heap.Push(&lb.requestQueue, req)
			break
		}
	}
	
	// Update metrics
	lb.metrics.ActiveRequests = lb.requestQueue.Len()
	if lb.metrics.ActiveRequests > 0 {
		totalWait := time.Duration(0)
		for _, req := range lb.requestQueue {
			totalWait += time.Since(req.ArrivalTime)
		}
		lb.metrics.AverageWaitTime = totalWait / time.Duration(lb.metrics.ActiveRequests)
	} else {
		lb.metrics.AverageWaitTime = 0
	}
}

// GetMetrics returns current load balancer metrics
func (lb *LoadBalancer) GetMetrics() LoadMetrics {
	lb.mutex.Lock()
	defer lb.mutex.Unlock()
	
	return lb.metrics
}

// SimulateRequests simulates incoming requests at high rate
func (lb *LoadBalancer) SimulateRequests(rate int, duration time.Duration) {
	startTime := time.Now()
	stopTime := startTime.Add(duration)
	
	for time.Now().Before(stopTime) {
		// Generate requests at the specified rate
		for i := 0; i < rate; i++ {
			req := Request{
				ID:           fmt.Sprintf("req-%d", lb.metrics.TotalRequests+i+1),
				Priority:     float64(time.Now().UnixNano() % 5), // Random priority 0-4
				RequiredTime: time.Duration(100 + time.Now().UnixNano()%400), // 100-500ms
				ArrivalTime:  time.Now(),
			}
			lb.AddRequest(req)
		}
		
		// Distribute requests to agents
		lb.DistributeRequests()
		
		// Sleep for a short duration to simulate request processing
		time.Sleep(10 * time.Millisecond)
	}
}

func main() {
	// Configure load balancer
	config := LoadBalancerConfig{
		MinAgents:         5,
		MaxAgents:         50,
		TargetUtilization: 0.75,
		AdjustmentInterval: 5 * time.Second,
		MaxWaitTime:       30 * time.Second,
	}
	
	// Create load balancer
	lb := NewLoadBalancer(config)
	
	// Start monitoring goroutine
	go func() {
		for {
			time.Sleep(5 * time.Second)
			metrics := lb.GetMetrics()
			fmt.Printf("Metrics: Agents=%d, Capacity=%.1f, Load=%.1f, Utilization=%.2f%%, Queue=%d, AvgWait=%.2fs\n",
				len(lb.agents), metrics.CurrentCapacity, metrics.CurrentLoad,
				(metrics.CurrentCapacity/metrics.CurrentCapacity)*100, metrics.ActiveRequests,
				metrics.AverageWaitTime.Seconds())
		}
	}()
	
	// Simulate high load (800+ requests/second)
	fmt.Println("Starting simulation with 800+ requests/second...")
	lb.SimulateRequests(800, 2*time.Minute)
	
	// Print final metrics
	finalMetrics := lb.GetMetrics()
	fmt.Printf("Final Metrics: TotalRequests=%d, PeakLoad=%.1f, FinalAgents=%d\n",
		finalMetrics.TotalRequests, finalMetrics.PeakLoad, len(lb.agents))
	
	// Export metrics to JSON file
	metricsJSON, _ := json.MarshalIndent(finalMetrics, "", "  ")
	os.WriteFile("load_balancer_metrics.json", metricsJSON, 0644)
	fmt.Println("Metrics exported to load_balancer_metrics.json")
}