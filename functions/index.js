const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();
const rdb = admin.database();

const promisePool = require("es6-promise-pool");
const PromisePool = promisePool.PromisePool;
const MAX_CONCURRENT = 3;

/* Array of Months to use in months conversion functions */
var months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

curDate = new Date();
//const nextMonth = monthNumToName(curDate.getMonth() + 2);
//const currentMonth = monthNumToName(curDate.getMonth() + 1);
const nextMonth = "December"
const currentMonth = "November"
const previousMonth = "October"
//const previousMonth = monthNumToName(curDate.getMonth());
const currentYear = curDate.getFullYear();
var lastDate = new Date(curDate.getFullYear() + 1, curDate.getMonth(), 0);
var lastDayofMonth = lastDate.getDate();

var balanceLessThan10Notififciation = true;
var balanceLessThan5Notififciation = true;
var balanceLessThan1Notififciation = true;

/* Convert month's number to month name  */
function monthNumToName(monthnum) {
  return months[monthnum - 1] || "";
}

/* Convert month name to corresponding month number */
function monthNameToNum(monthname) {
  var month = months.indexOf(monthname);
  return month ? month + 1 : 0;
}

/* Function to calculate bill of consumer */
const calculatebill = (energy) => {
  var bill;
  if (energy < 51) {
    bill = 0.30778 * energy;
  } else if ((energy == 51 || energy > 51) && energy < 301) {
    let _firstphasebill = 0.30778 * 50;
    let _remainingbill = 0.617488 * (energy - 50);
    bill = _firstphasebill + _remainingbill;
  } else if ((energy == 301 || energy > 301) && energy < 601) {
    let _firstphasebill = 0.30778 * 50 + 0.617488 * 250;
    let _remainingbill = 0.80138 * (energy - 300);
    bill = _firstphasebill + _remainingbill;
  } else if (energy > 601) {
    let _firstphasebill = 0.30778 * 50 + 0.617488 * 250 + 0.80138 * 300;
    let _remainingbill = 0.890422 * (energy - 600);
    bill = _firstphasebill + _remainingbill;
  }
  return bill.toFixed(2);
};

/* Function to convert amount paid into corresponding energy bought under prepaid metering */
const prepaidUnitsConversion = (amount) => {
  var units = 0;
  if (amount < 16) {
    units = amount / 0.30778;
  } else if ((amount == 16 || amount > 16) && amount < 171) {
    let _firstphaseunits = 15 / 0.30778;
    let _remainingunits = (amount - 15) / 0.617488;
    units = _firstphaseunits + _remainingunits;
  } else if (
    ((amount == 171 || amount > 171) && amount < 410) ||
    amount == 410
  ) {
    let _firstphaseunits = 15 / 0.30778 + 155 / 0.617488;
    let _remainingunits = (amount - 170) / 0.80138;
    units = _firstphaseunits + _remainingunits;
  } else if (amount > 410) {
    let _firstphaseunits = 15 / 0.30778 + 155 / 0.617488 + 240 / 0.80138;
    let _remainingunits = (amount - 410) / 0.890422;
    units = _firstphaseunits + _remainingunits;
  }
  return units.toFixed(2);
};

/* Function to trigger on consumpion value change */
exports.onConsumption = functions.database
  .ref("/meters/{meterId}/energy")
  .onWrite((change, context) => {
    const energy = change.after.val();
    const previousEnergy = change.before.val();
    const meterId = context.params.meterId;
    var mode, notificationToken;
    var meters;
    var prevReadingStatsDetails;
    var curReadingStatsDetails;

    return rdb
      .ref(`meters/${meterId}`)
      .once("value", (snapshot) => {
        if (snapshot.val() != null) {
          meters = snapshot.val();
          return (mode = meters.mode);
        }
      })
      .then((data) => {
        rdb
          .ref(`consumers/${meterId}/notificationToken`)
          .once("value", (data) => {
            return (notificationToken = data.val());
          });
      })
      .then((data) => {
        if (mode == "Prepaid") {
          var balance = calculateBalanceForEnergy(
            meters.balance,
            energy,
            previousEnergy
          );

          return change.after.ref.parent
            .child("balance")
            .set(balance.toFixed(2))
            .then(() => {
              checkForLowBalanceAndSendNotification(
                notificationToken,
                balance,
                meterId
              );
            });
        } else if (mode == "Postpaid") {
          if (meters.setDisconnection == true) {
            return checkDisConnectionSceduled(
              meterId,
              meters.setDisconnectionDate
            );
          }

          return rdb
            .ref(`readingStats/${meterId}/${currentYear}/${previousMonth}`)
            .once("value", (snapshot) => {
              prevReadingStatsDetails = snapshot.val();
            })
            .then(() => {
              return rdb
                .ref(`readingStats/${meterId}/${currentYear}/${currentMonth}`)
                .once("value", (snapshot) => {
                  curReadingStatsDetails = snapshot.val();
                  var energyUploaded = energy - previousEnergy;
                  var previousEnergyAtReadingStats =
                    curReadingStatsDetails.energy;
                  var energyConsumed =
                    energyUploaded + previousEnergyAtReadingStats;

                  /**Calculate current energy bill */
                  var bill = calculatebill(energyConsumed);

                  /**Calculate Total bill to set at meters details */
                  var previousMonthBillUnPaid =
                    prevReadingStatsDetails.bill -
                    prevReadingStatsDetails.amountPaid;
                  var curMonthBillUnPaid =
                    bill - curReadingStatsDetails.amountPaid;
                  var totalBill = previousMonthBillUnPaid + curMonthBillUnPaid;
                  return rdb
                    .ref(
                      `readingStats/${meterId}/${currentYear}/${currentMonth}`
                    )
                    .update({ energy: energyConsumed, bill: bill })
                    .then(() => {
                      change.after.ref.parent.child("bill").set(totalBill);
                    });
                });
            });
        }
        return console.log("Meters is null");
      });
  });

const senNotifification = (notificationToken, title, body, meterId) => {
  const payload = {
    notification: {
      title: title,
      body: body,
    },
  };
  return admin
    .messaging()
    .sendToDevice(notificationToken, payload)
    .then(saveNotification(title, body, meterId));
};

const saveNotification = (title, body, meterId) => {
  const notificationData = {
    title: title,
    body: body,
    sentAt: new Date().toISOString(),
    read: false,
  };
  return rdb.ref(`notifications/${meterId}`).push(notificationData);
};

const calculateBalanceForEnergy = (balance, energy, previousEnergy) => {
  var energyUploaded = energy - previousEnergy;
  balance -= energyUploaded;
  return balance.toFixed(2);
};

const checkForLowBalanceAndSendNotification = (
  notificationToken,
  balance,
  meterId
) => {
  /* Send notification to consumer if balance is less thant 10 */
  if (balance < 10 && balanceLessThan10Notififciation == true) {
    senNotifification(
      notificationToken,
      "Low Balance",
      "Your balance is less than 10 units, kindly recharge before you power switch off",
      meterId
    );
    balanceLessThan10Notififciation = false;
  }

  /* Send notification to consumer if balance is less thant 4 */
  if (balance < 5 && balanceLessThan5Notififciation == true) {
    senNotifification(
      notificationToken,
      "Low Balance",
      "Your balance is less than 5 units, kindly recharge before you power switch off",
      meterId
    );
    balanceLessThan5Notififciation = false;
  }

  /* Send notification to consumer if balance is less thant 1 */
  if (balance < 1.0 && balanceLessThan1Notififciation == true) {
    senNotifification(
      notificationToken,
      "Low Balance",
      "Your balance is less than 1 units, Your power would be going off in short time, kindly recharge.",
      meterId
    );
    balanceLessThan1Notififciation = false;
  }

  /* Send notification to consumer if balance is equal to zero and switch off meter */
  if (balance == 0.0) {
    const shutdowndata = {
      status: "off",
      controller: 3,
      shutDownTime: new Date().toISOString(),
    };
    rdb
      .ref(`meters/${meterId}`)
      .update(shutdowndata)
      .then(() => {
        return senNotifification(
          notificationToken,
          "Out of Balance",
          "You have run out balance. Recharge",
          meterId
        );
      });
  }
};

const getDetails = (path) => {
  var details;
  rdb.ref(path).once("value", (snapshot) => {
    details = snapshot.val();
  });
  return details;
};

const checkDisConnectionSceduled = (meterId, setDisconnectionDate) => {
  if (checkDueDate(setDisconnectionDate)) {
    return rdb
      .ref(`meters/${meterId}`)
      .update({ status: "off", controller: "3" });
  }
};

/*On Meter Reconnection*/
exports.onMeterReconnection = functions.database
  .ref("/meters/{meterId}/status")
  .onWrite((change, context) => {
    const status = change.after.val();
    const meterId = context.params.meterId;
    var meterDetails;
    var controller;
    var mode;
    var points;

    return rdb
      .ref(`meters/${meterId}`)
      .once("value", (snapshot) => {
        meterDetails = snapshot.val();
      })
      .then(() => {
        controller = meterDetails.controller;
        mode = meterDetails.mode;
        points = meterDetails.points;

        if (status == "on" && controller == 4) {
          if (mode == "Prepaid") {
            var shutdowntime = meterDetails.shutDownTime;

            /*get current time*/
            var currentTime = new Date();

            /*Calculate for shutdown time in hours by geting time difference in milliseconds*/
            var timeElapsedDuringShutdown =
              (currentTime.getTime() - shutdowntime.getTime()) / 3600000;

            /*Calculate points to be deducted from consumer base on time elapsed during shutdown*/
            const pointsToDeduct = Math.floor(timeElapsedDuringShutdown / 4.8);
            points = points - pointsToDeduct;

            /*Set new points of consumer*/
            return change.after.ref.parent.child("points").set(points);
          } else if (mode == "Postpaid") {
            var bill = Math.abs(meterDetails.bill);
            var balancebroughtForwardFromPostpaid = prepaidUnitsConversion(
              bill
            );
            return change.after.ref.parent
              .child(`${meterId}`)
              .update({
                balance: balancebroughtForwardFromPostpaid,
                mode: "Prepaid",
              })
              .then(() => {
                return rdb.ref(`consumers/${meterId}/mode`).set("Prepaid");
              })
              .then(() => {
                /*Send notification to inform consumer about mode transition*/
                var notificationToken;

                /*Retrieve notification token of consumer  and send notifcation*/
                return rdb
                  .ref(`consumers/${meterId}/notificationToken`)
                  .once("value", (data) => {
                    otificationToken = data.val();
                  })
                  .then(() => {
                    return senNotifification(
                      notificationToken,
                      "Mode Switched",
                      "Your mode have been switched from prepaid to postpaid due to inconsistency in bill payment, You would be able to switch back to postpaid after you have built for yourself the required trust.",
                      meterId
                    );
                  });
              });
          }
          return console.log("Could not retrieve meter mode");
        }
      });
  });

exports.onPayment = functions.database
  .ref("/payments/{paymentId}")
  .onCreate((snapshot, context) => {
    /*Retrieve payment detials */
    var paymentDetails = snapshot.val();
    var amountPaid = parseFloat(paymentDetails.amountPaid);
    console.log(`amount ${amountPaid}, meterId: ${meterId}`)
    var meterId = paymentDetails.meterId;

    /*Meter details, notification token id and previous points*/
    var meterDetails;
    var notificationToken;

    /*Retrieve meter details using meter Id*/
    return rdb
      .ref(`meters/${meterId}`)
      .once("value", (data) => {
        meterDetails = data.val();
        console.log(
          `I have my meter mode: ${meterDetails.mode} and status: ${meterDetails.status}`
        );
      })
      .then(() => {
        /*Retrieve notification token using meter id from consumers details*/
        return rdb
          .ref(`consumers/${meterId}/notificationToken`)
          .once("value", (data) => {
            notificationToken = data.val();
            console.log(`I have my notification token: ${notificationToken}`);
          });
      })
      .then(() => {
        var previousPoints = parseInt(meterDetails.points);
        if (meterDetails.mode == "Prepaid") {
          /*convert amount to corresponding energy*/
          var energyBought = parseFloat(prepaidUnitsConversion(amountPaid));

          /*Add balance to energy bought*/
          var balance = parseFloat(meterDetails.balance) + energyBought;
          balance = balance.toFixed(2);
          // balance = balance.toFixed(2);
          return rdb
            .ref(`meters/${meterId}/balance`)
            .set(parseFloat(balance))
            .then((data) => {
              /*Check if balance did not run out before purchase of energy, then add 5 points*/

              if (meterDetails.balance > 0) {
                return rdb
                  .ref(`meters/${meterId}/points`)
                  .set(parseInt(meterDetails.points) + 5);
              } else {
                /*Reconnect energy meter by switching on meter*/
                return rdb.ref(`meters/${meterId}`).update({
                  status: "on",
                  controller: "4",
                });
              }
            })
            .then(() => {
              /*Send notification to consumer on succesful energy recharge*/
              return senNotifification(
                notificationToken,
                "Balance Recharge",
                `You have successfully recharged ${energyBought} kW/h for meter ${meterId}. Your currnet balance is ${balance}.`,
                meterId
              );
            });
        } else if (meterDetails.mode == "Postpaid") {
          var previousMonthDetails;
          var currentMonthDetails;

          /*Retrieve curerent month's details*/
          return rdb
            .ref(`readingStats/${meterId}/${currentYear}/${previousMonth}`)
            .once("value", (data) => {
              previousMonthDetails = data.val();
            })
            .then(() => {
              return rdb
                .ref(`readingStats/${meterId}/${currentYear}/${currentMonth}`)
                .once("value", (data) => {
                  currentMonthDetails = data.val();
                });
            })
            .then(() => {
              /*If all of previous month's bill has not been paid*/
              if (
                previousMonthDetails.bill - previousMonthDetails.amountPaid >
                0
              ) {
                var totalamountpaid =
                  previousMonthDetails.amountPaid + amountPaid;
                var billBalance = previousMonthDetails.bill - totalamountpaid;
                var points =
                  previousPoints + calculateForNormalAwardedPoints(billBalance);
                /*If the total amount paid does not exceed the previous bill*/
                if (billBalance > 0 || billBalance == 0) {
                  return rdb
                    .ref(
                      `readingStats/${meterId}/${currentYear}/${previousMonth}/amountPaid`
                    )
                    .set(totalamountpaid)
                    .then(() => {
                      return rdb
                        .ref(`meters/${meterId}/points`)
                        .set(points)
                        .then(() => {
                          return senNotifification(
                            notificationToken,
                            "Bill Payment",
                            `You have successfully paid ${amountPaid} GHS for meter ${meterId} for the  month of  ${previousMonth} and obtained ${points} points`,
                            meterId
                          );
                        });
                    })
                    .then(() => {
                      /*Check if meter is off due to failure to pay bill, send notification to inform user amount to pay to be able to reconnect*/
                      if (
                        meterDetails.status == "off" &&
                        meterDetails.controller == 3
                      ) {
                        /* Set current bill owing at meter details*/
                        return rdb
                          .ref(`meters/${meterId}/bill`)
                          .set(meterDetails.bill - amountPaid)
                          .then(() => {
                            /*Send notification to inform user to pay outstanding debt to be able to reconnect*/
                            if (prevMonthDetails.bill - totalamountpaid > 0) {
                              return senNotifification(
                                notificationToken,
                                "Bill Payment",
                                `You have an outstanding balance of ${
                                  prevMonthDetails.bill -
                                  totalamountpaid +
                                  currentMonthDetails.bill
                                }, kindly repay more than amount owing to be able to reconnect.`,
                                meterId
                              );
                            } else {
                              return senNotifification(
                                notificationToken,
                                "Bill Payment",
                                `Dear consumer, kindly your remaining amount of ${currentMonthDetails.bill} to be able to reconnect`,
                                meterId
                              );
                            }
                          });
                      }
                    });
                } else {
                  /*If the total amount paid exceeds the previous bill*/

                  /*Calculate for the previous month's bill that is not paid and the amount to pay as current amount*/
                  var previousMonthBillLeft =
                    previousMonthDetails.bill - previousMonthDetails.amountPaid;
                  var currentMonthBillPaid = amountPaid - previousMonthBillLeft;

                  return rdb
                    .ref(
                      `readingStats/${meterId}/${currentYear}/${previousMonth}/amountPaid`
                    )
                    .set(
                      previousMonthBillLeft + previousMonthDetails.amountPaid
                    )
                    .then(() => {
                      return rdb
                        .ref(
                          `readingStats/${meterId}/${currentYear}/${currentMonth}/amountPaid`
                        )
                        .set(currentMonthBillPaid);
                    })
                    .then(() => {
                      if (
                        meterDetails.status == "off" &&
                        meterDetails.controller == 3
                      ) {
                        /* Calculate for amount still owing*/
                        const currentBillOwing =
                          currentMonthDetails.bill - currentMonthBillPaid;

                        /* If amount owing is more than or equal to zero */
                        if (currentBillOwing > 0 || currentBillOwing == 0) {
                          /* Set current bill owing at meter details*/
                          return rdb
                            .ref(`meters/${meterId}/bill`)
                            .set(meterDetails.bill - amountPaid)
                            .then(() => {
                              senNotifification(
                                notificationToken,
                                "Bill Payment",
                                `Dear consumer, kindly repay more than your outstanding bill of ${currentBillOwing} to be able to reconnect`,
                                meterId
                              );
                            });
                        } else {
                          return reconnect(meterId, currentBillOwing);
                        }
                      } else {
                        var points =
                          previousPoints + calculateForNormalAwardedPoints(0);
                        return rdb
                          .ref(`meters/${meterId}/points`)
                          .set(points)
                          .then(() => {
                            calculateAwardedPoints(
                              previousMonthDetails.bill,
                              currentMonthBillPaid,
                              meterId,
                              previousPoints
                            );
                          })
                          .then(() => {
                            senNotifification(
                              notificationToken,
                              "Bill Payment",
                              `You have successfully paid ${previousMonthBillLeft} GHS for the  month of  ${previousMonth} and  ${currentMonthBillPaid} GHS for the  month of  ${currentMonth} for meter ${meterId}.`,
                              meterId
                            );
                          });
                      }
                    });
                }
              } else {
                /**If all of previous month's bill has been paid */
                var currentMonthAmountAlreadyPaid = parseFloat(
                  currentMonthDetails.amountPaid
                );

                /* Calculate for total amount paid for current month*/
                var totalamountpaid =
                  currentMonthAmountAlreadyPaid + amountPaid;

                return rdb
                  .ref(
                    `readingStats/${meterId}/${currentYear}/${currentMonth}/amountPaid`
                  )
                  .set(totalamountpaid.toFixed(2))
                  .then(() => {
                    if (
                      meterDetails.status == "off" &&
                      meterDetails.controller == "3"
                    ) {
                      /*Calculate for current month still owning*/
                      const currentBillOwing =
                        currentMonthDetails.bill - totalamountpaid;
                      /*If current bill owing is greater than or equal to zero, send notification to consumer to more than bill owing and set current bill at meter details*/
                      if (currentBillOwing > 0 || currentBillOwing == 0) {
                        /* Set current bill owing at meter details*/
                        return rdb
                          .ref(`meters/${meterId}/bill`)
                          .set((meterDetails.bill - amountPaid).toFixed(2))
                          .then(() => {
                            senNotifification(
                              notificationToken,
                              "Bill Payment",
                              `Dear consumer, kindly repay more than your outstanding bill of ${currentBillOwing} to be able to reconnect`,
                              meterId
                            );
                          });
                      } else {
                        return reconnect(meterId, currentBillOwing);
                      }
                    } else {
                      return calculateAwardedPoints(
                        previousMonthDetails.bill,
                        totalamountpaid,
                        meterId,
                        previousPoints
                      ).then(() => {
                        return senNotifification(
                          notificationToken,
                          "Bill Payment",
                          `You have successfully paid ${amountPaid} GHS for meter ${meterId} for the  month of  ${currentMonth}.`,
                          meterId
                        );
                      });
                    }
                  });
              }
            });
        }
        return console.log("could not retrive mode");
      });
  });

const calculateForNormalAwardedPoints = (billBalance) => {
  var awards = 0;
  if (billBalance < 0) {
    if (!curDate.getDate() > 22) {
      awards = 8 - curDate.getDate();
    }
    return awards;
  }else{
    return 0
  }
};

const reconnect = (meterId, bill) => {
  const update = {
    status: "on",
    controller: "4",
    bill: bill,
  };
  return rdb.ref(`meters/${meterId}`).update(update);
};

/* Check if the amount paid upfront is greater than the previous bill to calculate the points
  points = days to deadline of payment*/
const calculateAwardedPoints = (
  previousBill,
  currentAmount,
  meterId,
  previousPoints
) => {
  var points;
  if (currentAmount > previousBill) {
    const today = new Date();
    const lastDateOfTheMonth = new Date(
      today.getFullYear(),
      today.getMonth() + 1,
      0
    );
    const DateToday = today.getDate();
    const DateLastDay = lastDateOfTheMonth.getDate();
    points = 7 + DateLastDay - DateToday;
    return rdb.ref(`meters/${meterId}/points`).set(points + previousPoints);
  } else {
    return;
  }
};

/*Function run on every first day of the month at 00:00 on the firstday of the month*/
//`00 50 ${lastDayofMonth} * *`
exports.processNextMonthDatabase = functions.pubsub
  .schedule("50 17 20 * *")
  .timeZone("Africa/Accra")
  .onRun(async (context) => {
    console.log("I started working here");
    /*Get all postpaid meter users*/
    const meters = await getListofPostPaidMeterIds();
    console.log(`Meters: ${meters}`);

    /*Create new current month reading details*/
    const promisePool = new PromisePool(
      () => createNewMonthReadingStats(meters),
      MAX_CONCURRENT
    );
    await promisePool.start();
    console.log("Next Month Database is set successfully");
  });

/** Process on bill on every first day of the month */
exports.processBill = functions.pubsub
  .schedule(`51 17 20 * *`)
  .timeZone("Africa/Accra")
  .onRun(async (context) => {
    /*Get all postpaid meter users*/
    const meters = await getListofPostPaidMeterIds();

    /*Create new current month reading details*/
    const promisePool = new PromisePool(
      () => billingProcess(meters),
      MAX_CONCURRENT
    );
    await promisePool.start();
    console.log("Bills processed successfully");
  });

/** Check on meter meter payments 8th if everymonth */
exports.scheduleDisconnectionDates = functions.pubsub
  .schedule("57 17 20 * *")
  .timeZone("Africa/Accra")
  .onRun(async (context) => {
    var postpaidMeters, partPaymentOrZeroPaymentConsumers, lessthan70PercentPayment, morethan70PercentPaymentWithNoArrears, morethan70PercentPaymentWithArrears

    postpaidMeters = await getListofPostPaidMeterIds();
    await checkConsumerBillPayment(postpaidMeters)
    // const promisePool = new PromisePool(
    //   () => checkConsumerBillPayment(postpaidMeters),
    //   MAX_CONCURRENT
    // );
    // await promisePool.start();
    console.log("Consumer Bills checked Successfully");

    // console.log(`My part payment or zero payment are: ${partPaymentOrZeroPaymentConsumers}`)

    //  lessthan70PercentPayment = getListOfMetersWithPartpaymentLessthan70Percent(partPaymentOrZeroPaymentConsumers);
    //   console.log(`My less than 70 payment or zero payment are: ${lessthan70PercentPayment}`)
    //  morethan70PercentPaymentWithNoArrears = getListOfMetersWithPartpaymentMorethan70PercentWithNoArrears(
    //     partPaymentOrZeroPaymentConsumers
    //   );
    //    console.log(`My more than 70 part payment with no arears are: ${morethan70PercentPaymentWithNoArrears}`)
    //   morethan70PercentPaymentWithArrears = getListOfMetersWithPartpaymentMorethan70PercentWithArrears(
    //     partPaymentOrZeroPaymentConsumers
    //   );
    //    console.log(`My more than 70 with payment with arears are: ${morethan70PercentPaymentWithArrears}`)

    //    if (
    //     lessthan70PercentPayment.length > 0 ||
    //     morethan70PercentPaymentWithArrears
    //   ) {
    //     const promisePool = new PromisePool(
    //       () =>
    //         sceduleDisconnection(
    //           lessthan70PercentPayment.concat(morethan70PercentPaymentWithArrears)
    //         ),
    //       MAX_CONCURRENT
    //     );
    //     await promisePool.start();
    //   }

    //   if (morethan70PercentPaymentWithNoArrears.length > 0) {
    //     const promisePool = new PromisePool(
    //       () =>
    //         updateReadingStatsWithPartpayment(
    //           morethan70PercentPaymentWithNoArrears
    //         ),
    //       MAX_CONCURRENT
    //     );
    //     await promisePool.start();
    //   }


    // return getListofPostPaidMeterIds().then((postPaidMeters) =>{
    //   postpaidMeters = postPaidMeters
    //   console.log(postpaidMeters)
    //    partPaymentOrZeroPaymentConsumers = getListofMeaterReadingStats(
    //     postpaidMeters
    //   );
    // }).then(() =>{
    //   console.log(partPaymentOrZeroPaymentConsumers)
    //   return lessthan70PercentPayment = getListOfMetersWithPartpaymentLessthan70Percent(
    //     partPaymentOrZeroPaymentConsumers
    //   );

    // }).then(()=>{
    //   return morethan70PercentPaymentWithNoArrears = getListOfMetersWithPartpaymentMorethan70PercentWithNoArrears(
    //     partPaymentOrZeroPaymentConsumers
    //   );
    // }).then(() =>{
    //     morethan70PercentPaymentWithArrears = getListOfMetersWithPartpaymentMorethan70PercentWithArrears(
    //     partPaymentOrZeroPaymentConsumers
    //   );
    // }).then(async() =>{
    //   if (
    //     lessthan70PercentPayment.length > 0 ||
    //     morethan70PercentPaymentWithArrears
    //   ) {
    //     const promisePool = new PromisePool(
    //       () =>
    //         sceduleDisconnection(
    //           lessthan70PercentPayment.concat(morethan70PercentPaymentWithArrears)
    //         ),
    //       MAX_CONCURRENT
    //     );
    //     await promisePool.start();
    //   }

    //   if (morethan70PercentPaymentWithNoArrears.length > 0) {
    //     const promisePool = new PromisePool(
    //       () =>
    //         updateReadingStatsWithPartpayment(
    //           morethan70PercentPaymentWithNoArrears
    //         ),
    //       MAX_CONCURRENT
    //     );
    //     await promisePool.start();
    //   }

    // })


});

/*Retrieve all postpaid meters*/
const getListofPostPaidMeterIds = () => {
  var meterList = [];
  return rdb
    .ref("meters")
    .orderByChild("mode")
    .equalTo("Postpaid")
    .once("value", (data) => {
      // var meters = data.val()
      if (data.val() != null) {
        data.forEach((meter) => {
          meterList.push(meter.key);
        });
      }
    })
    .then(() => {
      return meterList;
    });
};

/**Set database for next month meter readings */
const createNewMonthReadingStats = (meterlist) => {
  const readingStatData = {
    amountPaid: 0,
    energy: 0,
    bill: 0,
  };
  if (meterlist.length > 0) {
    meterlist.forEach((meter) => {
      rdb
        .ref(`readingStats/${meter}/${currentYear}/${nextMonth}`)
        .set(readingStatData);
    });
    return console.log(`${nextMonth} data created succesfully`);
  }
  return console.log(`${nextMonth} could not be created`);
};

/** If Amount paid for previous amount exceeds current month, then set current month's amount paid with ballance */
const checkIfAmountPaidExceedsPreviousMonthBill = (
  meterId,
  bill,
  amountpaid
) => {
  let balance = bill - amountpaid;
  if (balance < 0) {
    return rdb
      .ref(`readingStats/${meterId}/${currentYear}/${currentMonth}/amountPaid`)
      .set(Math.abs(balance));
  }
  return;
};

/* get previous month meter reading of a meter */
const getPreviousMonthReadingStats = async(meterId) => {
  var readingStats;
  return rdb
    .ref(`readingStats/${meterId}/${currentYear}/${previousMonth}/`)
    .once("value", (snapshot) => {
      readingStats = snapshot.val();
    })
    .then(() => {
      return readingStats;
    });
};

/** Retrieve notification token */
const getNotificationToken = (meterId) => {
  var notificationToken;
  return rdb
    .ref(`consumers/${meterId}/notificationToken`)
    .once("value", (snapshot) => {
      notificationToken = snapshot.val();
    })
    .then(() => {
      return notificationToken;
    });
};

/**Process Bill to process */
const billingProcess = (meterlist) => {
  if (meterlist.length > 0) {
    var previousMonthReadingStats, notificationToken;
    meterlist.forEach(async(meterId) => {
      previousMonthReadingStats = await  getPreviousMonthReadingStats(meterId);
      console.log("meterId: ",meterId,previousMonthReadingStats)
      notificationToken =  await getNotificationToken(meterId)
      await  checkIfAmountPaidExceedsPreviousMonthBill(
            meterId,
            previousMonthReadingStats.bill,
            previousMonthReadingStats.amountPaid
          );
      await senNotifification(
            notificationToken,
            "Monthly Bill",
            `Your monthly bill for ${previousMonth} is ${
              previousMonthReadingStats.bill
            }, amount paid is ${
              previousMonthReadingStats.amountPaid
            }, amount payable is ${
              previousMonthReadingStats.bill -
              previousMonthReadingStats.amountPaid
            }. Kindly pay before 7th of ${currentMonth}`,
            meterId
          );
      
    });
  } else {
    return console.log("Bill could not be processed");
  }
};

const checkConsumerBillPayment = async(meterlist) => {
  meterlist.forEach((meterId) => {
    rdb
      .ref(`readingStats/${meterId}/${currentYear}/${previousMonth}`)
      .once("value", async(snapshot) => {
        if (snapshot.val() != null) {
          let readingdata = snapshot.val();
          let bill = readingdata.bill;
          let amountpaid = readingdata.amountPaid;
          console.log("I did run ")
           if (amountpaid < bill) {
             let percentagePaid = (amountpaid / bill) * 100;
             if (percentagePaid < 70 || percentagePaid > 70 && meter.areas == true) {
              await sceduleDisconnection(meterId)
            }else if (percentagePaid > 70 && (meter.areas == false || meter.areas == null)){
              await updateReadingStatsWithPartpayment(meterId)
            }
          }
        }
      });
  });
};

const getListOfMetersWithPartpaymentLessthan70Percent = (meterlist) => {
  var meterList = [];
  meterlist.forEach((meter) => {
    let bill = meter.bill;
    let amountpaid = meter.amountPaid;
    let percentagePaid = (amountpaid / bill) * 100;
    if (percentagePaid < 70) {
      meterList.push(meterList.meterId);
    }
  });
  console.log("payments less than 70",meterList)
  return meterList;
};

const getListOfMetersWithPartpaymentMorethan70PercentWithNoArrears = (
  meterlist
) => {
  var meterList = [];
  meterlist.forEach((meter) => {
    let bill = meter.bill;
    let amountpaid = meter.amountPaid;
    let percentagePaid = (amountpaid / bill) * 100;
    if (percentagePaid > 70 && (meter.areas == false || meter.areas == null)) {
      meterList.push(meterList.meterId);
    }
  });
  console.log("less than 70 with no arrears", meterList)
  return meterList;
};

const getListOfMetersWithPartpaymentMorethan70PercentWithArrears = (
  meterlist
) => {
  var meterList = [];
  meterlist.forEach((meter) => {
    let bill = meter.bill;
    let amountpaid = meter.amountPaid;
    let percentagePaid = (amountpaid / bill) * 100;
    if (percentagePaid > 70 && meter.areas == true) {
      meterList.push(meterList.meterId);
    }
  });
  console.log("less than 70 with arears",meterList)
  return meterList;
};

const sceduleDisconnection = async (meterId) => {
      /**Retrive points of consumer */
      var points;
      return rdb
    .ref(`meters/${meterId}/points`)
    .once("value", (snapshot) => {
      points = snapshot.val();
    }).then(() =>{
      /*update meterDetails with disconnection details*/
  var setDisconnectionDate = calculateDisconncetionDate(points);
  return rdb.ref(`meters/${meterId}`).update({
    setDisconnectionDate: setDisconnectionDate,
    setDisconnection: true,
  });
    })
  
};

/**Calculate date to swithch power off if payment is not made */
const calculateDisconncetionDate = (points) => {
  var curDate = new Date();
  var dateInHours = points * 4.8;
  var dateInMilliSeconds = dateInHours * 3600000;
  var setDateInMilliSeconds = curDate.getTime() + dateInMilliSeconds;
  var setDate = new Date(setDateInMilliSeconds);
  var scheduleDate = setDate.toISOString();
  return scheduleDate;
};

/**Indicate arrears if consumer is not able to make full payment */
const updateReadingStatsWithPartpayment = (meterId) => {
    return rdb
      .ref(`readingStats/${meterId}/${currentYear}/${currentMonth}/arrears`)
      .set(true);
};

/**Check if set Date is due */
const checkDueDate = (date) => {
  const now = new Date();
  const setDate = new Date(date);
  if (setDate - now > 0) {
    return false;
  } else {
    return true;
  }
};

// exports.onBilling = functions.database
//   .ref("/meters/{meterId}/bill")
//   .onWrite((change, context) => {
//     var currentBill = change.after.val();
//     var payments;
//     var metId;
//     change.after.ref.parent
//       .child("meterId")
//       .once("value")
//       .then((snapShot) => {
//         metId = snapShot.val();
//       });

//     rdb
//       .ref("/payments")
//       .orderByChild("meterId")
//       .equalTo("DT10001")
//       .once("value", (data) => {
//         if (data.val() != null) {
//           var sumOfPayments = 0;
//           data.forEach((payments) => {
//             sumOfPayments += payments.amountPaid;
//           });
//           payments = sumOfPayments / data.numChildren();
//         }
//       });

//     if (currentBill > payments) {
//       change.after.ref.parent.child("controller").set(3);
//       return change.after.ref.parent.child("status").set("off");
//     } else {
//       return null;
//     }
//   });
