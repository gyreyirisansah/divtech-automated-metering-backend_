const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();
const rdb = admin.database();

const promisePool = require('es6-promise-pool');
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
const nextMonth = monthNumToName(curDate.getMonth() + 2);
const currentMonth = monthNumToName(curDate.getMonth() + 1);
const previousMonth = monthNumToName(curDate.getMonth());
const currentYear = Date.getFullYear();
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
    bill = 0.30778 * curr;
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
  return bill;
};

/* Function to convert amount paid into corresponding energy bought under prepaid metering */
const prepaidUnitsConversion = (amount) => {
  var units;
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
  return units;
};

/* Function to trigger on consumpion value change */
exports.onConsumption = functions.database
  .ref("/meters/{meterId}/energy")
  .onWrite((change, context) => {
    var mode;
    const energy = change.after.val();
    var meterId = context.params.meterId;
    var notificationToken;

    /* Retrieves meter mode */
    change.after.ref.parent.child("mode").once("value", (data) => {
      mode = data.val();
    });

    /*Retrives notification token of consumer */
    rdb.ref(`consumers/${meterId}/notificationToken`).once("value", (data) => {
      notificationToken = data.val();
    });

    /* For Prepaid Consumers*/
    if (mode == "Prepaid") {
      var balance;
      /* Retrive balance of consumer  and subtract energy consumed from balance */
      change.after.ref.parent.child("balance").once("value", (data) => {
        balance = data.val();
        balance = balance - energy;
      });

      /* Set the balance */
      return change.after.ref.parent
        .child("balance")
        .set(balance)
        .then(() => {
          /* Send notification to consumer if balance is less thant 10 */
          if (balance < 10 && balanceLessThan10Notififciation == true) {
            const payload = {
              notification: {
                title: "Low Balance",
                body:
                  "Your balance is less than 10 units, kindly recharge before you power switch off",
              },
            };
            balanceLessThan10Notififciation = false;
            return admin.messaging().sendToDevice(notificationToken, payload);
          }
          /* Send notification to consumer if balance is less thant 4 */
          if (balance < 5 && balanceLessThan5Notififciation == true) {
            const payload = {
              notification: {
                title: "Low Balance",
                body:
                  "Your balance is less than 5 units, kindly recharge before you power switch off",
              },
            };
            balanceLessThan5Notififciation = false;
            return admin.messaging().sendToDevice(notificationToken, payload);
          }

          /* Send notification to consumer if balance is less thant 1 */
          if (balance < 1.0 && balanceLessThan1Notififciation == true) {
            const payload = {
              notification: {
                title: "Low Balance",
                body:
                  "Your balance is less than 1 units, Your power would be going off in short time, kindly recharge.",
              },
            };
            balanceLessThan1Notififciation = false;
            return admin.messaging().sendToDevice(notificationToken, payload);
          }

          /* Send notification to consumer if balance is equal to zero and switch off meter */
          if (balance == 0.0) {
            const shutdowndata = {
              status: "off",
              controller: 3,
              shutdowntime: new Date().toISOString(),
            };
            return change.after.ref.parent
              .child(`${meterId}`)
              .update(shutdowndata)
              .then(() => {
                const payload = {
                  notification: {
                    title: "Out of Balance",
                    body: "You have run out balance. Recharge",
                  },
                };

                return admin
                  .messaging()
                  .sendToDevice(notificationToken, payload);
              });
          }
        });
    } else if (mode == "Postpaid") {
      /* Postpaid Meters*/

      /* Calculate monthly blill on the go*/

      /*variable to hold previous energy value of the month atreadingStats*/
      var previousEnergyAtReadingStats;

      /*variable to hold previous bill unpaid at atreadingStats*/
      var previousBillUnPaid;

      /*variable to hold previous energy value at meters field*/
      const previousenergy = change.before.val();

      /*Calculate instantaneous energy consumed*/
      const energyUploaded = energy - previousenergy;

      /*Retrieve previous energy value at ReadingStats*/
      rdb
        .ref(`readingStats/${meterId}/${currentYear}/${currentMonth}/energy`)
        .once("value", (data) => {
          previousEnergyAtReadingStats = data.val();
        });

      /*Retrieve bill paid for current month at readingStats*/
      var currentMonthBillPaid;
      rdb
        .ref(`readingStats/${meterId}/${currentYear}/${currentMonth}/bill`)
        .once("value", (data) => {
          currentMonthBillPaid = data.val();
        });

      /*Retrieve previous bill unpaid value at ReadingStats*/
      rdb
        .ref(`readingStats/${meterId}/${currentYear}/${previousMonth}`)
        .once("value", (data) => {
          let prevMonthDetails = data.val();
          previousBillUnPaid =
            prevMonthDetails.bill - prevMonthDetails.amountPaid;
        });

      /*calculate monthly energy consumed by instantaneous energy consumed to previous energy reading at Reading stats field*/
      const energyConsumed = energyUploaded + previousEnergyAtReadingStats;

      /*Calculate monthly bill using bill calcualtion function*/
      const bill = calculatebill(energyConsumed);

      /*Update values object*/
      const updateValue = {
        energy: energyConsumed,
        bill: bill,
      };

      /*Update bill value at meters which is equal to total bill of consumer*/
      change.after.ref.parent
        .child("bill")
        .set(bill - currentMonthBillPaid + previousBillUnPaid);

      /*Update energy and bill fields at readingStats */
      return rdb
        .ref(`readingStats/${meterId}/${currentYear}/${currentMonth}/energy`)
        .update(updateValue);
    }
    return;
  });

/*On Meter Reconnection*/
exports.onMeterReconnection = functions.database
  .ref("/meters/{meterId}/status")
  .onWrite((change, context) => {
    const status = change.after.val();
    const meterId = context.params.meterId;
    var controller;
    var mode;
    var points;

    /*Retrive controller value*/
    change.after.ref.parent.child("controller").once("value", (data) => {
      controller = data.val();
    });

    /*Retrive mode of meter*/
    change.after.ref.parent.child("mode").once("value", (data) => {
      mode = data.val();
    });

    /*Retrive points of meter*/
    change.after.ref.parent.child("points").once("value", (data) => {
      points = data.val();
    });

    /*Check if meter is reconnected after disconnection due to balance exhausted or failure to pay bill*/
    if (status === "on" && controller == 4) {
      /*Prepaid Meters on Recharge*/
      if (mode == "Prepaid") {
        /*Retrieve time meter was shutdown due to balance exhausted*/
        var shutdowntime;
        change.after.ref.parent.child("shutdowntime").once("value", (data) => {
          shutdowntime = new Date(data.val());
        });
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
        /*For post paid meters*/

        var bill;
        var balancebroughtForwardFromPostpaid;

        /*Retrieve value of bill brought foward from postpaid*/
        change.after.ref.parent.child("bill").once("value", (data) => {
          bill = Math.abs(data.val());
        });

        /*Calcualte equivalent prepaid balance using balance brought forward*/
        balancebroughtForwardFromPostpaid = prepaidUnitsConversion(bill);

        /*Update meter details and change meter mode to prepaid*/
        const additionalUserData = {
          balance: balancebroughtForwardFromPostpaid,
          mode: "Prepaid",
        };
        /*Update consumer details, by changeing mode to prepaid*/
        return change.after.ref.parent
          .child(`${meterId}`)
          .update(additionalUserData)
          .then(() => {
            return rdb.ref(`consumers/${meterId}/mode`).set("Prepaid");
          })
          .then(() => {
            /*Send notification to inform consumer about mode transition*/
            var notificationToken;

            /*Retrieve notification token of consumer  and send notifcation*/
            rdb
              .ref(`consumers/${meterId}/notificationToken`)
              .once("value", (data) => {
                notificationToken = data.val();
              });

            const payload = {
              notification: {
                title: "Mode Switched",
                body:
                  "Your mode have been switched from prepaid to postpaid due to inconsistency in bill payment, You would be able to switch back to postpaid after you have built for yourself the required trust.",
              },
            };

            return admin.messaging().sendToDevice(notificationToken, payload);
          });
      }
    }
  });

/*On payment of Bill or purchase of balance*/
exports.onPayment = functions.database
  .ref("/payments/{paymentId}")
  .onWrite((change, context) => {
    /*Retrieve payment detials */
    var paymentDetails = change.after.val();
    var amountPaid = paymentDetails.amountPaid;
    var meterId = paymentDetails.meterId;
    /*Meter details, notification token id and previous points*/
    var meterDetails;
    var notificationToken;
    var previousPoints;

    /*Retrieve meter details using meter Id*/
    rdb.ref(`meters/${meterId}`).once("value", (data) => {
      meterDetails = data.val();
    });

    /*Retrieve notification token using meter id from consumers details*/
    rdb.ref(`consumers/${meterId}/notificationToken`).once("value", (data) => {
      notificationToken = data.val();
    });

    /*Retrieve consumers points from meterDetails*/
    previousPoints = meterDetails.points;

    /*Check if payment was from a  prepaid meter*/
    if (meterDetails.mode == "Prepaid") {
      /*Retrieve balance from meter details*/
      var previousBalance = meterDetails.balance;

      /*convert amount to corresponding energy*/
      energyBought = prepaidUnitsConversion(amountPaid);

      /*Add balance to energy bought*/
      var balance = previousBalance + energyBought;

      /*Set energy bought at meters details and send notification to user*/
      return rdb
        .ref(`meters/${meterId}/balance`)
        .set(balance)
        .then((data) => {
          const payload = {
            notification: {
              title: "Balance Recharge",
              body: `You have successfully recharged ${energyBought} kW/h for meter ${meterId}. Your currnet balance is ${balance}.`,
            },
          };
          /*Check if balance did not run out before purchase of energy, then add 5 points*/
          if (previousBalance > 0) {
            rdb.ref(`meters/${meterId}/points`).set(previousPoints + 5);
          } else {
            /*Reconnect energy meter by switching on meter*/
            const updateDetails = {
              status: "on",
              controller: 4,
            };
            rdb.ref(`meters/${meterId}`).update(updateDetails);
          }

          /*Send notification to consumer on succesful energy recharge*/
          return admin.messaging().sendToDevice(notificationToken, payload);
        });
    } else if (meterDetails.mode == "Postpaid") {
      /*If payment was from a postpaid enery meter*/

      /*Retrieve details on previous month at reading statistics*/
      var previousMonthDetails;
      rdb
        .ref(`readingStats/${meterId}/${currentYear}/${previousMonth}`)
        .once("value", (data) => {
          previousMonthDetails = data.val();
        });

      /*Retrieve curerent month's details*/
      var currentMonthDetails;
      rdb
        .ref(`readingStats/${meterId}/${currentYear}/${currentMonth}`)
        .once("value", (data) => {
          currentMonthDetails = data.val();
        });

      /*If all of previous month's bill has not been paid*/
      if (previousMonthDetails.bill - previousMonthDetails.amountPaid > 0) {
        /*Calculate for the total amount paid, amount paid already plus the amount just paid*/
        var totalamountpaid = previousMonthDetails.amountPaid + amountPaid;

        /*If the total amount paid does not exceed the previous bill*/
        if (
          previousMonthDetails.bill - totalamountpaid > 0 ||
          previousMonthDetails.bill - totalamountpaid == 0
        ) {
          /* Set previous month with total amount paid and send notification */
          return rdb
            .ref(`readingStats/${meterId}/${currentYear}/${previousMonth}`)
            .amountPaid.set(totalamountpaid)
            .then(() => {
              const payload = {
                notification: {
                  title: "Bill Payment",
                  body: `You have successfully paid ${amountPaid} GHS for meter ${meterId} for the  month of  ${previousMonth}.`,
                },
              };
              return admin.messaging().sendToDevice(notificationToken, payload);
            })
            .then(() => {
              /*Check if meter is off due to failure to pay bill, send notification to inform user amount to pay to be able to reconnect*/
              if (
                meterDetails.status == "off" &&
                meterDetails.controller == 3
              ) {
                /* Set current bill owing at meter details*/
                rdb
                  .ref(`meters/${meterId}/bill`)
                  .set(meterDetails.bill - amountPaid);

                /*Send notification to inform user to pay outstanding debt to be able to reconnect*/
                if (prevMonthDetails.bill - totalamountpaid > 0) {
                  /*Send notification*/
                  const payload = {
                    notification: {
                      title: "Bill Payment",
                      body: `You have an outstanding balance of ${
                        prevMonthDetails.bill -
                        totalamountpaid +
                        currentMonthDetails.bill
                      }, kindly repay more than amount owing to be able to reconnect.`,
                    },
                  };
                  return admin
                    .messaging()
                    .sendToDevice(notificationToken, payload);
                } else {
                  /*Send notification to user to pay any other debt left to be able to reconnect*/
                  const payload = {
                    notification: {
                      title: "Bill Payment",
                      body: `Dear consumer, kindly your remaining amount of ${currentMonthDetails.bill} to be able to reconnect`,
                    },
                  };
                  return admin
                    .messaging()
                    .sendToDevice(notificationToken, payload);
                }
              }
              return;
            });
        } else {
          /*If the total amount paid exceeds the previous bill*/

          /*Calculate for the previous month's bill that is not paid and the amount to pay as current amount*/
          var previousMonthBillLeft =
            previousMonthDetails.bill - previousMonthDetails.amountPaid;
          var currentMonthBillPaid = amountPaid - previousMonthBillLeft;

          /*Set amount paid at previous month and current month*/
          return rdb
            .ref(`readingStats/${meterId}/${currentYear}/${previousMonth}`)
            .amountPaid.set(
              previousMonthBillLeft + previousMonthDetails.amountPaid
            )
            .then(() => {
              return rdb
                .ref(`readingStats/${meterId}/${currentYear}/${currentMonth}`)
                .amountPaid.set(currentMonthBillPaid);
            })
            .then(() => {
              /*If meter is switched off then check if all debt has been paid and switch meter on, else send consumer notifcation to pay all bill to reconnect*/
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
                  rdb
                    .ref(`meters/${meterId}/bill`)
                    .set(meterDetails.bill - amountPaid);

                  /* Send notification to alert consumer to pay outstanding bill in order to reconnect*/
                  const payload = {
                    notification: {
                      title: "Bill Payment",
                      body: `Dear consumer, kindly repay more than your outstanding bill of ${currentBillOwing} to be able to reconnect`,
                    },
                  };
                  return admin
                    .messaging()
                    .sendToDevice(notificationToken, payload);
                } else {
                  return reconnect(meterId, currentBillOwing);
                }
              } else {
                /**if meter has not been switched off then send notification on successful bill payment amount paid for this month and send notification */
                const payload = {
                  notification: {
                    title: "Bill Payment",
                    body: `You have successfully paid ${previousMonthBill} GHS for the  month of  ${previousMonth} and  ${currentMonthBillPaid} GHS for the  month of  ${currentMonth} for meter ${meterId}.`,
                  },
                };

                calculateAwardedPoints(
                  previousMonthDetails.bill,
                  currentMonthBillPaid,
                  meterId,
                  previousPoints
                );
                return admin
                  .messaging()
                  .sendToDevice(notificationToken, payload);
              }
            });
        }
      } else {
        /*If all of previous month bill has been paid*/

        /*Retrieve current month bill already paid*/
        var currentMonthAmountAlreadyPaid = currentMonthDetails.amountPaid;

        /* Calculate for total amount paid for current month*/
        var totalamountpaid = currentMonthAmountAlreadyPaid + amountPaid;

        /*Set amount paid */
        return rdb
          .ref(`readingStats/${meterId}/${currentYear}/${currentMonth}`)
          .amountPaid.set(totalamountpaid)
          .then(() => {
            /*If meter was switched off due failure to pay bill, reconnect if consumer has paid more than owing else send notification to inform user to pay any amount owing*/
            if (meterDetails.status == "off" && meterDetails.controller == 3) {
              /*Calculate for current month still owning*/
              const currentBillOwing =
                currentMonthDetails.bill - totalamountpaid;

              /*If current bill owing is greater than or equal to zero, send notification to consumer to more than bill owing and set current bill at meter details*/
              if (currentBillOwing > 0 || currentBillOwing == 0) {
                /* Set current bill owing at meter details*/
                rdb
                  .ref(`meters/${meterId}/bill`)
                  .set(meterDetails.bill - amountPaid);
                const payload = {
                  notification: {
                    title: "Bill Payment",
                    body: `Dear consumer, kindly repay more than your outstanding bill of ${currentBillOwing} to be able to reconnect`,
                  },
                };

                return admin
                  .messaging()
                  .sendToDevice(notificationToken, payload);
              } else {
                return reconnect(meterId, currentBillOwing);
              }
            } else {
              /*send notification to consumer on succesful  meter payment and calculate for awarded points*/

              calculateAwardedPoints(
                previousMonthDetails.bill,
                totalamountpaid,
                meterId,
                previousPoints
              );

              const payload = {
                notification: {
                  title: "Bill Payment",
                  body: `You have successfully paid ${amountPaid} GHS for meter ${meterId} for the  month of  ${currentMonth}.`,
                },
              };
              return admin.messaging().sendToDevice(notificationToken, payload);
            }
          });
      }
    }
  });

const reconnect = (meterId, bill) => {
  const update = {
    status: "on",
    controller: 4,
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
    return null;
  }
};

/*Function run on every first day of the month at 00:00 on the firstday of the month*/
exports.processNextMonthDatabase = functions.pubsub
  .schedule(`23 50 ${lastDayofMonth} * *`)
  .timeZone("Africa/Accra")
  .onRun(async (context) => {
    /*Get all postpaid meter users*/
    const meters = await getListofPostPaidMeterIds();

    /*Create new current month reading details*/
    const promisePool = new PromisePool(
      () => createNewMonthReadingStats(meters),
      MAX_CONCURRENT
    );
    await promisePool.start();
    console.log("Next Month Database is set successfully");
  });

/*Retrieve all postpaid meters*/
const getListofPostPaidMeterIds = () => {
  var meterList = [];

  rdb
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
    });

  return meterList;
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

/* Send notification to user to inform user on bill */
const sendNotificationToConsumersOnBill = (notificationToken, bill, amountpaid) =>{
  let balance = bill - amountpaid
    const payload ={
      notification: {
        title: "Monthly Bill",
        body: `Your monthly bill for ${previousMonth} is ${bill}, amount paid is ${amountpaid}, amount payable is ${balance}. Kindly pay before 7th of ${currentMonthDetails}`
      }
    }
    return admin.messaging().sendToDevice(notificationToken,payload) 
}

/** If Amount paid for previous amount exceeds current month, then set current month's amount paid with ballance */
const checkIfAmountPaidExceedsPreviousMonthBill = (meterId, bill, amountpaid) =>{
  let balance = bill - amountpaid
  if (balance <0){
    return rdb.ref(`readingStats/${meterId}/${currentYear}/${currentMonth}/amountPaid`).set(Math.abs(balance))
  }
  return
}

/* get previous month meter reading of a meter */
const getPreviousMonthReadingStats = (meterId) =>{
  var readingStats
  rdb.ref(`readingStats/${meterId}/${currentYear}/${currentMonth}/`).once("value", snapshot =>{
    readingStats = snapshot.val()
  })
  return readingStats
}

/** Retrieve notification token */
const getNotificationToken = (meterId) => {
  var notificationToken
  rdb.ref(`consumers/${meterId}/notificationToken`).once("value", snapshot => {
    notificationToken = snapshot.val()
  })
  return notificationToken
}


/**Process Bill to process */
const processBill = async (meterlist) =>{
  if(meterlist.length >0){
    meterlist.forEach(meterId => {
      var previousMonthReadingStats = await getPreviousMonthReadingStats(meterId)
      var notificationToken = await getNotificationToken(meterId)
      await checkIfAmountPaidExceedsPreviousMonthBill(meterId, previousMonthReadingStats.bill ,previousMonthReadingStats.amountPaid)
      await sendNotificationToConsumersOnBill(notificationToken,previousMonthReadingStats.bill, previousMonthReadingStats.amountPaid )
    });
  }else{
    return console.log("Bill could not be processed")
  }
}
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
