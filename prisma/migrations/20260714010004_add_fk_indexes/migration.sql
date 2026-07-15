-- CreateIndex
CREATE INDEX "Complaint_customerId_idx" ON "Complaint"("customerId");

-- CreateIndex
CREATE INDEX "Complaint_propertyId_idx" ON "Complaint"("propertyId");

-- CreateIndex
CREATE INDEX "Complaint_technicianId_idx" ON "Complaint"("technicianId");

-- CreateIndex
CREATE INDEX "Invoice_customerId_idx" ON "Invoice"("customerId");

-- CreateIndex
CREATE INDEX "Issue_visitId_idx" ON "Issue"("visitId");

-- CreateIndex
CREATE INDEX "Issue_propertyId_idx" ON "Issue"("propertyId");

-- CreateIndex
CREATE INDEX "Message_customerId_idx" ON "Message"("customerId");

-- CreateIndex
CREATE INDEX "Message_technicianId_idx" ON "Message"("technicianId");

-- CreateIndex
CREATE INDEX "Message_complaintId_idx" ON "Message"("complaintId");

-- CreateIndex
CREATE INDEX "Message_templateId_idx" ON "Message"("templateId");

-- CreateIndex
CREATE INDEX "Payment_customerId_idx" ON "Payment"("customerId");

-- CreateIndex
CREATE INDEX "Photo_propertyId_idx" ON "Photo"("propertyId");

-- CreateIndex
CREATE INDEX "Photo_visitId_idx" ON "Photo"("visitId");

-- CreateIndex
CREATE INDEX "Photo_complaintId_idx" ON "Photo"("complaintId");

-- CreateIndex
CREATE INDEX "Property_customerId_idx" ON "Property"("customerId");

-- CreateIndex
CREATE INDEX "Property_serviceAreaId_idx" ON "Property"("serviceAreaId");

-- CreateIndex
CREATE INDEX "Property_roundId_idx" ON "Property"("roundId");

-- CreateIndex
CREATE INDEX "Round_serviceAreaId_idx" ON "Round"("serviceAreaId");

-- CreateIndex
CREATE INDEX "ServicePlan_propertyId_idx" ON "ServicePlan"("propertyId");

-- CreateIndex
CREATE INDEX "ServicePlan_serviceId_idx" ON "ServicePlan"("serviceId");

-- CreateIndex
CREATE INDEX "TechnicianServiceArea_serviceAreaId_idx" ON "TechnicianServiceArea"("serviceAreaId");

-- CreateIndex
CREATE INDEX "Visit_serviceId_idx" ON "Visit"("serviceId");

-- CreateIndex
CREATE INDEX "Visit_propertyId_idx" ON "Visit"("propertyId");

-- CreateIndex
CREATE INDEX "Visit_roundId_idx" ON "Visit"("roundId");

-- CreateIndex
CREATE INDEX "Visit_servicePlanId_idx" ON "Visit"("servicePlanId");

-- CreateIndex
CREATE INDEX "Visit_technicianId_idx" ON "Visit"("technicianId");
