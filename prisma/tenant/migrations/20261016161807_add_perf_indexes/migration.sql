-- CreateIndex
CREATE INDEX "Complaint_status_idx" ON "Complaint"("status");

-- CreateIndex
CREATE INDEX "Customer_status_createdAt_idx" ON "Customer"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Invoice_status_dueDate_idx" ON "Invoice"("status", "dueDate");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE INDEX "Visit_date_status_idx" ON "Visit"("date", "status");

-- CreateIndex
CREATE INDEX "Visit_roundId_date_idx" ON "Visit"("roundId", "date");

-- CreateIndex
CREATE INDEX "Visit_technicianId_date_idx" ON "Visit"("technicianId", "date");
