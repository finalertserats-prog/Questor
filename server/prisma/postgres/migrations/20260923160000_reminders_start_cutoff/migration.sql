-- CreateTable
CREATE TABLE "ReminderWindow" (
    "id" TEXT NOT NULL DEFAULT 'reminders',
    "activeFrom" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReminderWindow_pkey" PRIMARY KEY ("id")
);
